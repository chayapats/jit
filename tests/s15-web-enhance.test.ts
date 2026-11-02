import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { lookupS15Asset, s15AssetUrl } from "../src/s15/web";

// Real served s15.js (with its credential detector prelude) under a minimal DOM double; no browser, network or delays.
const source = new TextDecoder().decode(lookupS15Asset(s15AssetUrl("s15.js"))!.body);

type Listener = (event: Record<string, unknown>) => unknown;
class FakeElement {
  dataset: Record<string, string> = {}; hidden = false; value = ""; textContent = ""; id = ""; innerHTML = ""; focused = false;
  listeners = new Map<string, Listener[]>(); parts = new Map<string, FakeElement>(); children: FakeElement[] = []; parentNode: FakeElement | null = null; attributes = new Map<string, string>();
  constructor(init: Partial<FakeElement> = {}) { Object.assign(this, init); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  async fire(type: string, event: Record<string, unknown> = {}) { let prevented = false; const full = { preventDefault: () => { prevented = true; }, target: this, ...event }; for (const fn of this.listeners.get(type) ?? []) await fn(full); return prevented; }
  querySelector(selector: string) { return this.parts.get(selector) ?? null; }
  querySelectorAll(selector: string) { return selector === ".s15-row" ? this.children.filter(child => child.id.startsWith("s15-row-")) : []; }
  contains(element: unknown) { return element === this || [...this.parts.values()].includes(element as FakeElement) || this.children.includes(element as FakeElement); }
  closest(selector: string) { return selector === "[data-prefill]" && this.dataset.prefill !== undefined ? this : null; }
  replaceWith(other: FakeElement) { const parent = this.parentNode!; parent.children[parent.children.indexOf(this)] = other; other.parentNode = parent; }
  insertBefore(child: FakeElement, before: FakeElement) { child.parentNode = this; this.children.splice(this.children.indexOf(before), 0, child); }
  appendChild(child: FakeElement) { child.parentNode = this; this.children.push(child); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  remove() {}
  focus() { this.focused = true; }
  blur() { this.focused = false; }
}

function composerDom(conversation = "conv1") {
  const area = new FakeElement({ id: "s15-text" }), requestId = new FakeElement({ value: "req-original" });
  const bar = new FakeElement({ hidden: true }), line = new FakeElement({ dataset: { saved: "saved", restored: "restored", sensitive: "sensitive" } });
  const sending = new FakeElement({ hidden: true }), unknown = new FakeElement({ hidden: true }), clear = new FakeElement();
  const form = new FakeElement({ id: "s15-composer" }) as FakeElement & { action: string; requestSubmit: () => void; submits: number };
  form.action = "http://jit.test/s15/forms/message"; form.submits = 0; form.requestSubmit = () => { form.submits++; void form.fire("submit"); };
  for (const [selector, element] of [["textarea", area], ["[data-draft-bar]", bar], ["[data-draft-status]", line], ["[data-sending]", sending], ["[data-unknown]", unknown], ["[data-draft-clear]", clear], ["input[name=requestId]", requestId]] as const) form.parts.set(selector, element);
  const app = new FakeElement({ dataset: { conversation, cursor: "0" } }), phase = new FakeElement({ id: "s15-phase", dataset: { working: "Jit has started", needs: "1 thing needs you", done: "done", reconnected: "Reconnected", reset: "reset" } });
  const documentListeners = new Map<string, Listener[]>();
  const elements = new Map<string, FakeElement>([["s15-composer", form], ["s15-text", area], ["s15-phase", phase]]);
  const document = {
    activeElement: null as unknown, getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (selector: string) => selector === ".s15-app" ? app : null, querySelectorAll: () => [],
    addEventListener: (type: string, fn: Listener) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]),
    importNode: (node: FakeElement) => node,
  };
  const store = new Map<string, string>();
  const localStorage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } };
  return { form, area, requestId, unknown, sending, line, document, documentListeners, store, localStorage, elements };
}
const context = (dom: ReturnType<typeof composerDom>, fetch: (...args: unknown[]) => Promise<unknown>, timers: (() => Promise<void>)[] = []) => ({
  document: dom.document, localStorage: dom.localStorage, fetch, setTimeout: (fn: () => Promise<void>) => { timers.push(fn); return 1; }, location: { href: "http://jit.test/chats/conv1" },
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
