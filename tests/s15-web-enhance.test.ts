import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { lookupS15Asset, s15AssetUrl } from "../src/s15/web";

// Real served s15.js (with its credential detector prelude) under a minimal DOM double; no browser, network or delays.
const source = new TextDecoder().decode(lookupS15Asset(s15AssetUrl("s15.js"))!.body);

type Listener = (event: Record<string, unknown>) => unknown;
class FakeElement {
  dataset: Record<string, string> = {}; hidden = false; value = ""; textContent = ""; id = ""; innerHTML = ""; focused = false; checked = false; readOnly = false;
  listeners = new Map<string, Listener[]>(); parts = new Map<string, FakeElement>(); children: FakeElement[] = []; parentNode: FakeElement | null = null; attributes = new Map<string, string>();
  constructor(init: Partial<FakeElement> = {}) { Object.assign(this, init); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  async fire(type: string, event: Record<string, unknown> = {}) { let prevented = false; const full = { preventDefault: () => { prevented = true; }, target: this, ...event }; for (const fn of this.listeners.get(type) ?? []) await fn(full); return prevented; }
  querySelector(selector: string) { return this.parts.get(selector) ?? null; }
  querySelectorAll(selector: string) { return selector === ".s15-row" ? this.children.filter(child => child.id.startsWith("s15-row-")) : []; }
  contains(element: unknown) { return element === this || [...this.parts.values()].includes(element as FakeElement) || this.children.includes(element as FakeElement); }
  closest(selector: string) { return selector === "[data-prefill]" && this.dataset.prefill !== undefined ? this : null; }
  replaceWith(other: FakeElement) {
    const parent = this.parentNode!;
    if (parent.children.includes(this)) parent.children[parent.children.indexOf(this)] = other;
    for (const [selector, part] of parent.parts) if (part === this) parent.parts.set(selector, other);
    other.parentNode = parent;
  }
  insertBefore(child: FakeElement, before: FakeElement) { child.parentNode = this; this.children.splice(Math.max(0, this.children.indexOf(before)), 0, child); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  appendChild(child: FakeElement) { child.parentNode = this; this.children.push(child); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  remove() {}
  focus() { this.focused = true; }
  blur() { this.focused = false; }
}

type FakeForm = FakeElement & { action: string; requestSubmit: () => void; submits: number };
/** One composer region; `answer` mirrors the server-rendered "Answering the question above" control. */
function makeComposer(requestIdValue: string, answer: { value: string; revision: string; checked: boolean } | null = null) {
  const area = new FakeElement({ id: "s15-text" }), requestId = new FakeElement({ value: requestIdValue });
  const bar = new FakeElement({ hidden: true }), line = new FakeElement({ dataset: { saved: "saved", restored: "restored", sensitive: "sensitive" } });
  const sending = new FakeElement({ hidden: true }), unknown = new FakeElement({ hidden: true }), refused = new FakeElement({ hidden: true, dataset: { fallback: "Not sent" } }), clear = new FakeElement(), grow = new FakeElement();
  const form = new FakeElement({ id: "s15-composer" }) as FakeForm;
  form.action = "http://jit.test/s15/forms/message"; form.submits = 0; form.requestSubmit = () => { form.submits++; void form.fire("submit"); };
  for (const [selector, element] of [["textarea", area], ["[data-draft-bar]", bar], ["[data-draft-status]", line], ["[data-sending]", sending], ["[data-unknown]", unknown], ["[data-refused]", refused], ["[data-draft-clear]", clear], ["input[name=requestId]", requestId], [".s-bar .s-grow", grow]] as const) { form.parts.set(selector, element); element.parentNode = form; }
  grow.parentNode = form;
  let label: FakeElement | null = null;
  if (answer) {
    label = new FakeElement(); const box = new FakeElement({ value: answer.value, checked: answer.checked }), revision = new FakeElement({ value: answer.revision });
    label.parts.set("input[name=answer]", box); label.parts.set("input[name=answerRevision]", revision); label.parentNode = form; form.parts.set(".s15-answer", label);
  }
  return { form, area, requestId, unknown, refused, sending, line, label };
}
function composerDom(conversation = "conv1", answer: Parameters<typeof makeComposer>[1] = null) {
  const { form, area, requestId, unknown, refused, sending, line, label } = makeComposer("req-original", answer);
  const app = new FakeElement({ dataset: { conversation, cursor: "0" } }), phase = new FakeElement({ id: "s15-phase", dataset: { working: "Jit has started", needs: "1 thing needs you", done: "done", reconnected: "Reconnected", reset: "reset" } });
  const documentListeners = new Map<string, Listener[]>();
  const elements = new Map<string, FakeElement>([["s15-composer", form], ["s15-text", area], ["s15-phase", phase]]);
  const document = {
    activeElement: null as unknown, getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => selector === ".s15-app" ? app : null, querySelectorAll: () => [],
    addEventListener: (type: string, fn: Listener) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]),
    importNode: (node: FakeElement) => node,
  };
  // A swapped composer replaces the element registered under its id.
  form.parentNode = new FakeElement(); form.parentNode.children.push(form);
  const original = form.replaceWith.bind(form);
  form.replaceWith = (other: FakeElement) => { original(other); elements.set("s15-composer", other); const text = other.parts.get("textarea"); if (text) elements.set("s15-text", text); };
const store = new Map<string, string>();
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
  return { form, area, requestId, unknown, refused, sending, line, label, app, document, documentListeners, store, localStorage, elements };
}
const context = (dom: ReturnType<typeof composerDom>, fetch: (...args: unknown[]) => Promise<unknown>, timers: (() => Promise<void>)[] = []) => ({
  document: dom.document, localStorage: dom.localStorage, fetch, setTimeout: (fn: () => Promise<void>) => { timers.push(fn); return 1; }, location: { href: "http://jit.test/chats/conv1", assigned: [] as string[], assign(href: string) { this.assigned.push(href); } },
  FormData: class { constructor(readonly form: unknown) {} *[Symbol.iterator]() { yield ["requestId", dom.requestId.value]; yield ["text", dom.area.value]; } },
  URLSearchParams, DOMParser: class { parseFromString() { return { getElementById: () => null, querySelector: () => null }; } }, Event: class { constructor(readonly type: string) {} }, Date, JSON, navigator: {},
});

test("Enter sends, Shift+Enter and IME composition never send", async () => {
  const dom = composerDom(); runInNewContext(source, context(dom, async () => { throw new Error("offline"); }));
  expect(await dom.area.fire("keydown", { key: "Enter", shiftKey: true })).toBe(false);
  expect(await dom.area.fire("keydown", { key: "Enter", isComposing: true })).toBe(false);
  expect(await dom.area.fire("keydown", { key: "Enter", keyCode: 229 })).toBe(false);
  expect(dom.form.submits).toBe(0);
  expect(await dom.area.fire("keydown", { key: "Enter" })).toBe(true);
  expect(dom.form.submits).toBe(1);
});

test("an unknown receipt keeps the text and the same request id, so a resend cannot duplicate work", async () => {
  const dom = composerDom(), bodies: string[] = [];
  runInNewContext(source, context(dom, async (_url, init) => { bodies.push(String((init as { body: URLSearchParams }).body)); throw new Error("network"); }));
  dom.area.value = "Create hello.txt";
  expect(await dom.form.fire("submit")).toBe(true);
  expect(dom.unknown.hidden).toBe(false); expect(dom.sending.hidden).toBe(true); expect(dom.area.value).toBe("Create hello.txt"); expect(dom.requestId.value).toBe("req-original");
  await dom.form.fire("submit");
  expect(bodies).toEqual(["requestId=req-original&text=Create+hello.txt", "requestId=req-original&text=Create+hello.txt"]);
});

test("drafts are browser-local text only and credential-shaped text is never stored", async () => {
  const dom = composerDom(); runInNewContext(source, context(dom, async () => ({})));
  dom.area.value = "Plan the trip"; await dom.area.fire("input");
  expect(JSON.parse(dom.store.get("s15-draft:conv1")!)).toMatchObject({ text: "Plan the trip" });
  expect([...dom.store.keys()]).toEqual(["s15-draft:conv1"]);
  dom.area.value = "token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"; await dom.area.fire("input");
  expect(dom.store.has("s15-draft:conv1")).toBe(false); expect(dom.line.textContent).toBe("sensitive");
  // A restored draft never carries a request id, approval or rule: only the text comes back.
  const again = composerDom(); again.store.set("s15-draft:conv1", JSON.stringify({ text: "Plan the trip", at: Date.now() }));
  runInNewContext(source, context(again, async () => ({})));
  expect(again.area.value).toBe("Plan the trip"); expect(again.requestId.value).toBe("req-original");
});

test("a prefill chip fills the composer with its trusted text and sends nothing", async () => {
  const dom = composerDom(); let fetched = 0;
  runInNewContext(source, context(dom, async () => { fetched++; return {}; }));
  const chip = new FakeElement({ dataset: { prefill: "เริ่มทำ #42" } });
  let prevented = false;
  for (const fn of dom.documentListeners.get("click") ?? []) await fn({ target: chip, preventDefault: () => { prevented = true; } });
  expect(prevented).toBe(true); expect(dom.area.value).toBe("เริ่มทำ #42"); expect(dom.area.focused).toBe(true); expect(fetched).toBe(0); expect(dom.form.submits).toBe(0);
});

test("live refresh replaces changed rows except the focused one, and reconnect re-sends nothing", async () => {
  const dom = composerDom(), thread = new FakeElement({ id: "s15-thread" }), latest = new FakeElement({ id: "latest" });
  const row = (id: string, sig: string, phase: string) => new FakeElement({ id: `s15-row-${id}`, dataset: { sig, phase } });
  const a = row("a", "1-working", "working"), b = row("b", "1-working", "working");
  for (const child of [a, b, latest]) thread.appendChild(child);
  dom.elements.set("s15-thread", thread); dom.elements.set("latest", latest); dom.elements.set("s15-row-a", a); dom.elements.set("s15-row-b", b);
  const scroll = new FakeElement(), app = new FakeElement({ dataset: { conversation: "conv1", cursor: "0" } }), slot = new FakeElement({ id: "s15-banner" }), bold = new FakeElement();
  slot.parts.set("b", bold); dom.elements.set("s15-banner", slot);
  dom.document.querySelector = (selector: string) => selector === ".s15-app" ? app : selector === "[data-live]" || selector === ".s-scroll" ? scroll : null;
  const freshThread = new FakeElement({ id: "s15-thread" }), a2 = row("a", "2-done", "done"), b2 = row("b", "2-done", "done"), c = row("c", "1-received", "received");
  for (const child of [a2, b2, c]) freshThread.appendChild(child);
  const fresh = { getElementById: (id: string) => id === "s15-thread" ? freshThread : null, querySelector: () => null };
  const calls: { url: string; method: string }[] = []; let offline = true;
  const timers: (() => Promise<void>)[] = [];
  const ctx = context(dom, async (url, init) => {
    calls.push({ url: String(url), method: (init as { method?: string } | undefined)?.method ?? "GET" });
    if (String(url).includes("/events")) { if (offline) throw new Error("down"); return { ok: true, status: 200, json: async () => ({ events: [{ sequence: 3 }], cursor: 3, needs: 0 }) }; }
    return { ok: true, status: 200, text: async () => "fresh" };
  }, timers);
  ctx.DOMParser = class { parseFromString() { return fresh; } } as never;
  dom.document.activeElement = b; // The owner is reading row b.
  runInNewContext(source, ctx);
  expect(timers).toHaveLength(1);
  await timers.shift()!(); // Offline: nothing changes and it retries later.
  expect(thread.children).toEqual([a, b, latest]);
  offline = false; await timers.shift()!();
  expect(thread.children[0]).toBe(a2); expect(thread.children[1]).toBe(b); expect(thread.children[2]).toBe(c); expect(thread.children[3]).toBe(latest);
  expect(dom.elements.get("s15-phase")!.textContent).toBe("done");
  expect(calls.every(call => call.method === "GET")).toBe(true);
  expect(calls.some(call => call.url.includes("/s15/forms/"))).toBe(false);
  expect(bold.textContent).toBe("Reconnected"); expect(slot.innerHTML).toContain('role="status"');
});

/** Live poll fixture: one events page, then the fresh render produced by `fresh`. */
async function livePoll(dom: ReturnType<typeof composerDom>, fresh: { getElementById(id: string): unknown; querySelector(selector: string): unknown }, events: { events: unknown[]; cursor: number; needs: number }) {
  const scroll = new FakeElement(), timers: (() => Promise<void>)[] = [], urls: string[] = [];
  let live = true;
  dom.document.querySelector = (selector: string) => selector === ".s15-app" ? dom.app : selector === "[data-live]" ? live ? scroll : null : selector === ".s-scroll" ? scroll : null;
  const ctx = context(dom, async url => { urls.push(String(url)); return String(url).includes("/events") ? { ok: true, status: 200, json: async () => events } : { ok: true, status: 200, text: async () => "fresh" }; }, timers);
  ctx.DOMParser = class { parseFromString() { return fresh; } } as never;
  runInNewContext(source, ctx);
  return { timers, urls, scroll, setLive: (value: boolean) => { live = value; } };
}

test("a live refresh keeps an unchecked answer choice and its exact question reference with the draft", async () => {
  const dom = composerDom("conv1", { value: "question-r3", revision: "3", checked: false });
  dom.area.value = "A separate new request";
  const next = makeComposer("req-fresh", { value: "question-r4", revision: "4", checked: true });
  const run = await livePoll(dom, { getElementById: (id: string) => id === "s15-composer" ? next.form : null, querySelector: () => null }, { events: [{ sequence: 9 }], cursor: 9, needs: 1 });
  await run.timers.shift()!();
  const current = dom.elements.get("s15-composer")!;
  expect(current).toBe(next.form);
  // The draft text, request id and the owner's own answer state (unchecked, r3) all survive the refresh.
  expect(next.area.value).toBe("A separate new request"); expect(next.requestId.value).toBe("req-original");
  const label = current.parts.get(".s15-answer")!;
  expect(label).toBe(dom.label!); expect(label.parts.get("input[name=answer]")!.checked).toBe(false);
  expect(label.parts.get("input[name=answer]")!.value).toBe("question-r3"); expect(label.parts.get("input[name=answerRevision]")!.value).toBe("3");
});

test("a question that appears while the owner types is offered unchecked, never pre-selected for that text", async () => {
  const dom = composerDom("conv1"); dom.area.value = "Plan the trip";
  const next = makeComposer("req-fresh", { value: "question-r1", revision: "1", checked: true });
  const run = await livePoll(dom, { getElementById: (id: string) => id === "s15-composer" ? next.form : null, querySelector: () => null }, { events: [{ sequence: 4 }], cursor: 4, needs: 1 });
  await run.timers.shift()!();
  expect(next.label!.parts.get("input[name=answer]")!.checked).toBe(false); expect(next.area.value).toBe("Plan the trip");
});

test("the browser cursor advances past applied events and polling stops once nothing is live", async () => {
  const dom = composerDom("conv1"); dom.app.dataset.cursor = "64";
  const run = await livePoll(dom, { getElementById: () => null, querySelector: () => null }, { events: [{ sequence: 70 }], cursor: 70, needs: 0 });
  await run.timers.shift()!();
  expect(run.urls[0]).toBe("/chats/conv1/events?after=64"); expect(dom.app.dataset.cursor).toBe("70");
  expect(run.timers).toHaveLength(1);
  run.setLive(false); await run.timers.shift()!();
  expect(run.urls.at(-2)).toBe("/chats/conv1/events?after=70");
  expect(run.timers).toHaveLength(0);
});

test("an expired session during an enhanced send keeps the draft and goes to sign-in", async () => {
  const dom = composerDom("conv1");
  const ctx = context(dom, async () => ({ ok: false, status: 401, text: async () => "refused" }));
  const signIn = new FakeElement(); signIn.setAttribute("href", "/s14/login");
  ctx.DOMParser = class { parseFromString() { return { getElementById: () => null, querySelector: (selector: string) => selector === "[data-sign-in]" ? signIn : null }; } } as never;
  runInNewContext(source, ctx);
  dom.area.value = "Keep this request";
  await dom.form.fire("submit");
  expect(ctx.location.assigned).toEqual(["/s14/login"]);
  expect(JSON.parse(dom.store.get("s15-draft:conv1")!)).toMatchObject({ text: "Keep this request" });
  expect(dom.area.value).toBe("Keep this request"); expect(dom.sending.hidden).toBe(true); expect(dom.area.readOnly).toBe(false);
});

test("any other refusal page without a composer shows its reason and keeps text and request id", async () => {
  const dom = composerDom("conv1");
  const ctx = context(dom, async () => ({ ok: false, status: 403, text: async () => "refused" }));
  const heading = new FakeElement({ textContent: "This page is out of date. Reload it and try again." });
  ctx.DOMParser = class { parseFromString() { return { getElementById: () => null, querySelector: (selector: string) => selector === "h1" ? heading : null }; } } as never;
  runInNewContext(source, ctx);
  dom.area.value = "Keep this request";
  await dom.form.fire("submit");
  expect(dom.refused.hidden).toBe(false); expect(dom.refused.textContent).toBe("This page is out of date. Reload it and try again.");
  expect(dom.area.value).toBe("Keep this request"); expect(dom.requestId.value).toBe("req-original"); expect(ctx.location.assigned).toEqual([]);
});

test("the text box is read-only while a send is pending, so nothing typed meanwhile is lost", async () => {
  const dom = composerDom("conv1"); let release: (value: unknown) => void = () => {};
  const ctx = context(dom, () => new Promise(resolve => { release = resolve; }));
  runInNewContext(source, ctx);
  dom.area.value = "First message";
  const sending = dom.form.fire("submit");
  await Promise.resolve();
  expect(dom.area.readOnly).toBe(true); expect(dom.sending.hidden).toBe(false);
  release({ ok: false, status: 503, text: async () => "down" }); await sending;
  expect(dom.area.readOnly).toBe(false);
});
