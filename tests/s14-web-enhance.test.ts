import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");

test.each(["s14-work-status", "s14-pane-status", "s14-computer-status"])("live refresh updates visible %s text and tone with the final result before polling stops", async badgeId => {
  let focused = false;
  const element = (innerHTML: string, className = "") => ({ innerHTML, className, dataset: {} as Record<string, string>, contains: () => focused, querySelector: () => null });
  const content = element("Running"), badge = element("Running", "s-pill strong");
  const label = badgeId === "s14-computer-status" ? "! Unavailable" : "✓ Ready", tone = badgeId === "s14-computer-status" ? "s-pill danger" : "s-pill ok";
  const nextContent = element("Evidence ready"), nextBadge = element(label, tone);
  const screen = element("original request ID"), nextScreen = element("fresh request ID");
  screen.dataset.sig = nextScreen.dataset.sig = "same-generation-and-lease";
  const controls = element("Agent control"), nextControls = element("Owner takeover");
  controls.dataset.sig = "lease-1"; nextControls.dataset.sig = "lease-2";
  const current = new Map([["s14-pane-live", content], [badgeId, badge], ["s14-computer-screen", screen], ["s14-computer-more", controls]]);
  const fresh = new Map([["s14-pane-live", nextContent], [badgeId, nextBadge], ["s14-computer-screen", nextScreen], ["s14-computer-more", nextControls]]);
  const page = (elements: typeof current, live: boolean) => ({
    documentElement: { dataset: {} }, body: {}, activeElement: {},
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    querySelector: (selector: string) => selector === "[data-live]" && live ? {} : null,
  });
  const ticks: Array<() => Promise<void>> = [];
  runInNewContext(source, {
    document: page(current, true), location: { href: "http://localhost:3001/work/fixture", hash: "" },
    DOMParser: class { parseFromString() { return page(fresh, false); } },
    fetch: async () => ({ ok: true, text: async () => "fresh page" }),
    setTimeout: (tick: () => Promise<void>) => ticks.push(tick),
  });
  // An active reader keeps content and badge together and defers the final poll.
  focused = true; await ticks.shift()!();
  expect(content.innerHTML).toBe("Running"); expect(badge.innerHTML).toBe("Running"); expect(ticks).toHaveLength(1);
  focused = false; await ticks.shift()!();
  expect(content.innerHTML).toBe("Evidence ready"); expect(badge.innerHTML).toBe(label); expect(badge.className).toBe(tone);
  expect(ticks).toHaveLength(0);
  expect(screen.innerHTML).toBe("original request ID");
  expect(controls.innerHTML).toBe("Owner takeover");
  expect(controls.dataset.sig).toBe("lease-2");
});

/** Minimal DOM/event fixture for the real enhancement script; no browser, clock delays or network is used. */
function computerBrowser() {
  type Form = { dataset: Record<string, string>; elements: { disabled: boolean }[]; matches(selector: string): boolean };
  const form = (input: boolean): Form => ({ dataset: input ? { input: "true" } : {}, elements: [{ disabled: false }], matches() { return !!this.dataset.computerStale; } });
  let active: unknown = null, now = 1800000000000;
  function region(html: string, sig: string) {
    let contents = html;
    return {
      dataset: { sig }, className: "s-stack", focused: {}, open: false,
      forms: html.includes("form") ? [form(html === "input form")] : [],
      get innerHTML() { return contents; },
      set innerHTML(value: string) { contents = value; this.forms = value.includes("form") ? [form(value === "input form")] : []; },
      contains(element: unknown) { return element === this.focused; },
      querySelector(selector: string) {
        if (selector === "details[open]") return this.open ? {} : null;
        if (selector === "[data-computer-stale]") return this.forms.find(f => f.dataset.computerStale) ?? null;
        return null;
      },
    };
  }
  const initial = "1.1.1", changed = "2.1.2";
  const ids = ["s14-live", "s14-computer-screen", "s14-computer-more"];
  const make = (key: string, owner: boolean) => new Map(ids.map(id => [id, region(id === "s14-live" ? "takeover form" : id === "s14-computer-screen" ? owner ? "input form" : "view only" : "facts", `${key}.${owner}.${id}`)]));
  const current = make(initial, true), ticks: Array<() => unknown> = [], listeners = new Map<string, (event: any) => unknown>();
  const computer = {
    dataset: { computer: "jit", key: initial },
    querySelectorAll() { return [...current.values()].flatMap(r => r.forms); },
    querySelector() { return current.get("s14-computer-screen")!.forms.find(f => f.dataset.input) ?? null; },
  };
  const page = (elements: typeof current, key: string) => ({
    documentElement: { dataset: {} }, body: {}, hidden: false,
    get activeElement() { return active; },
    getElementById(id: string) { return elements.get(id) ?? null; },
    querySelectorAll() { return []; },
    querySelector(selector: string) { return selector === "[data-computer]" ? { ...computer, dataset: { ...computer.dataset, key } } : null; },
    addEventListener(name: string, handler: (event: any) => unknown) { listeners.set(name, handler); },
  });
  const document = page(current, initial), events = new Map<string, (event: any) => Promise<void>>();
  let fetches = 0, failure: "http" | "network" | null = null, serverKey = changed, serverOwner = false;
  let releaseRead: (() => void) | null = null;
  let holdNext = false;
  runInNewContext(source, {
    document, location: { href: "http://localhost:3001/team/jit?tab=computer", hash: "" }, Date: { now: () => now },
    DOMParser: class { parseFromString(text: string) { const snapshot = JSON.parse(text); return page(make(snapshot.key, snapshot.owner), snapshot.key); } },
    EventSource: class { addEventListener(name: string, handler: (event: any) => Promise<void>) { events.set(name, handler); } close() {} },
    setTimeout(callback: () => unknown) { ticks.push(callback); },
    fetch: async () => {
      fetches++;
      const fail = failure; failure = null;
      if (fail === "network") throw new Error("offline");
      const text = JSON.stringify({ key: serverKey, owner: serverOwner });
      if (holdNext) { holdNext = false; await new Promise<void>(resolve => { releaseRead = resolve; }); }
      return { ok: fail !== "http", text: async () => text };
    },
  });
  return {
    current, computer, listeners, initial, changed,
    get fetches() { return fetches; },
    fail(value: typeof failure) { failure = value; },
    focus(id: string | null) { active = id ? current.get(id)!.focused : null; },
    server(key: string, owner = false) { serverKey = key; serverOwner = owner; },
    advance(ms: number) { now += ms; },
    async state(key = changed, owner = false, expiresAt = now + 60000) {
      const [revision, generation, leaseRevision] = key.split(".").map(Number);
      await events.get("state")!({ data: JSON.stringify({ computer: { revision, generation, state: "running" }, lease: { revision: leaseRevision, actor: owner ? "owner" : null, expiresAt } }) });
    },
    hold() { holdNext = true; return () => releaseRead!(); },
    async blur() { active = null; listeners.get("focusout")!({}); await ticks.shift()!(); },
    async closeDetails(id: string) { current.get(id)!.open = false; await listeners.get("toggle")!({}); },
  };
}

test.each(["http", "network"] as const)("computer state retries the same revision after a %s refresh failure and disables stale input and takeover forms immediately", async failure => {
  const b = computerBrowser(), oldForms = b.computer.querySelectorAll();
  b.fail(failure);
  await b.state();
  expect(b.fetches).toBe(1);
  expect(b.current.get("s14-computer-screen")!.innerHTML).toBe("input form");
  expect(oldForms.every(f => f.elements.every(c => c.disabled))).toBe(true);
  let prevented = false;
  b.listeners.get("submit")!({ target: oldForms[0], preventDefault() { prevented = true; } });
  expect(prevented).toBe(true);
  await b.state();
  expect(b.fetches).toBe(2);
  expect(b.current.get("s14-computer-screen")!.innerHTML).toBe("view only");
  expect(b.current.get("s14-live")!.forms[0]!.elements[0]!.disabled).toBe(false);
  await b.state(); expect(b.fetches).toBe(2);
});

test.each(["s14-computer-screen", "s14-live"])("a changed controller fences focused %s forms and retries on blur before the next state event", async id => {
  const b = computerBrowser(), region = b.current.get(id)!, oldForm = region.forms[0]!;
  b.focus(id);
  await b.state();
  expect(region.forms[0]).toBe(oldForm);
  expect(oldForm.elements.every(c => c.disabled)).toBe(true);
  expect(oldForm.dataset.computerStale).toBe("true");
  await b.blur();
  expect(b.fetches).toBe(2);
  expect(region.forms[0]).not.toBe(oldForm);
  expect(b.current.get("s14-computer-screen")!.innerHTML).toBe("view only");
  await b.state(); expect(b.fetches).toBe(2);
});

test("a deferred computer region retries when its open details closes", async () => {
  const b = computerBrowser(), region = b.current.get("s14-computer-more")!;
  region.open = true;
  await b.state();
  expect(region.dataset.sig).toContain(b.initial);
  await b.closeDetails("s14-computer-more");
  expect(region.dataset.sig).toContain(b.changed);
  expect(b.fetches).toBe(2);
});

test("an in-flight page response cannot restore old controls after a newer controller state arrives", async () => {
  const b = computerBrowser(), release = b.hold();
  const reading = b.state();
  b.server("3.1.3", true);
  await b.state("3.1.3", true);
  release(); await reading;
  expect(b.current.get("s14-computer-screen")!.forms[0]!.elements[0]!.disabled).toBe(true);
  expect(b.current.get("s14-live")!.dataset.sig).toContain(b.initial);
  await b.state("3.1.3", true);
  expect(b.fetches).toBe(2);
  expect(b.current.get("s14-computer-screen")!.dataset.sig).toContain("3.1.3");
  expect(b.current.get("s14-computer-screen")!.forms[0]!.elements[0]!.disabled).toBe(false);
});

test("owner lease expiry fences input and refreshes even without a revision change or a minute passing", async () => {
  const b = computerBrowser(), oldInput = b.current.get("s14-computer-screen")!.forms[0]!;
  b.advance(10000); b.server(b.initial, false);
  await b.state(b.initial, true, 0);
  expect(oldInput.elements[0]!.disabled).toBe(true);
  expect(b.fetches).toBe(1);
  expect(b.current.get("s14-computer-screen")!.innerHTML).toBe("view only");
});

function signInBrowser(responses: { status: number; ok: boolean; state?: string }[]) {
  const ticks: (() => Promise<void>)[] = [], replaced: string[] = [];
  const signIn = { dataset: { signIn: "/api/s14/sign-in/codex/flow", signInPage: "/settings/provider?flow=flow" } };
  const none = () => null;
  runInNewContext(source, {
    document: { documentElement: { dataset: {} }, body: { dataset: {} }, querySelector: (selector: string) => selector === "[data-sign-in]" ? signIn : null, querySelectorAll: () => [], getElementById: none, addEventListener() {} },
    location: { replace: (url: string) => replaced.push(url) }, addEventListener() {},
    fetch: async () => { const next = responses.shift()!; return { ...next, json: async () => ({ state: next.state }) }; },
    setTimeout: (tick: () => Promise<void>) => ticks.push(tick),
  });
  return { ticks, replaced };
}

test("device sign-in keeps following through a transient read failure", async () => {
  const { ticks, replaced } = signInBrowser([{ status: 503, ok: false }, { status: 200, ok: true, state: "ready" }]);
  await ticks.shift()!();
  expect(replaced).toEqual([]);
  await ticks.shift()!();
  expect(replaced).toEqual(["/settings/provider?flow=flow"]);
});

test("device sign-in leaves the waiting page when the session has expired", async () => {
  const { ticks, replaced } = signInBrowser([{ status: 401, ok: false }]);
  await ticks.shift()!();
  expect(replaced).toEqual(["/settings/provider?flow=flow"]);
  expect(ticks).toHaveLength(0);
});

/** A shared browser cookie may change the root preference, never the already displayed room. */
test.each([false, true])("root live reads stay bound to their conversation and reject a mismatched response (%s)", async mismatched => {
  const element = (innerHTML: string) => ({ innerHTML, className: "", dataset: {} as Record<string, string>, contains: () => false, querySelector: () => null });
  const content = element("Room A messages"), revision = { value: "1" }, paths: string[] = [], ticks: Array<() => Promise<void>> = [];
  const documentPage = (room: string, live: boolean, text: string, version: string) => ({
    documentElement: { dataset: {} }, body: {}, activeElement: null,
    querySelectorAll: () => [], getElementById: (id: string) => id === "s14-live" ? room === "A" && live ? content : element(text) : null,
    querySelector(selector: string) {
      if (selector === ".s-app[data-conversation]") return { dataset: { conversation: room } };
      if (selector === "[data-live]" && live) return {};
      if (selector === "[data-composer] input[name=expectedRevision]") return live ? revision : { value: version };
      return null;
    },
  });
  const context = {
    document: documentPage("A", true, "Room A messages", "1"), location: { href: "http://localhost:3001/", pathname: "/", search: "", hash: "" },
    DOMParser: class { parseFromString() { return documentPage(mismatched ? "B" : "A", false, mismatched ? "Room B messages" : "New room A answer", "7"); } },
    fetch: async (url: string) => { paths.push(url); return { ok: true, text: async () => "page" }; },
    setTimeout: (tick: () => Promise<void>) => ticks.push(tick),
  };
  runInNewContext(source, context); await ticks.shift()!();
  expect(paths).toEqual(["/chats/A"]);
  expect(content.innerHTML).toBe(mismatched ? "Room A messages" : "New room A answer");
  expect(revision.value).toBe(mismatched ? "1" : "7");
});

test("an open focused Progress disclosure keeps its shell while results, approval/status and progress update", async () => {
  const element = (innerHTML: string, busy = false) => ({ innerHTML, className: "", dataset: {} as Record<string, string>, contains: () => busy, querySelector: () => busy ? {} : null });
  const shell = element("Open disclosure with focused summary", true), primary = element("Running"), details = element("Lane running"), status = element("Running");
  const current = new Map([["s14-pane-live", shell], ["s14-progress-primary", primary], ["s14-progress-details", details], ["s14-pane-status", status]]);
  const fresh = new Map([["s14-pane-live", element("New shell")], ["s14-progress-primary", element("Result and exact approval")], ["s14-progress-details", element("Lane complete")], ["s14-pane-status", element("Ready")]]);
  const page = (elements: typeof current, live: boolean) => ({
    documentElement: { dataset: {} }, body: {}, activeElement: {}, getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [], querySelector: (selector: string) => selector === "[data-live]" && live ? {} : null,
  });
  const ticks: Array<() => Promise<void>> = [];
  runInNewContext(source, {
    document: page(current, true), location: { href: "http://localhost:3001/work/W", hash: "" },
    DOMParser: class { parseFromString() { return page(fresh, false); } },
    fetch: async () => ({ ok: true, text: async () => "page" }), setTimeout: (tick: () => Promise<void>) => ticks.push(tick),
  });
  await ticks.shift()!();
  expect(shell.innerHTML).toBe("Open disclosure with focused summary");
  expect(primary.innerHTML).toBe("Result and exact approval"); expect(details.innerHTML).toBe("Lane complete"); expect(status.innerHTML).toBe("Ready");
  expect(ticks).toHaveLength(0);
});

test("an inline work result updates while its receipt disclosure defers the surrounding conversation", async () => {
  const make = (id: string, innerHTML: string, busy = false) => ({ id, innerHTML, className: "", dataset: {}, contains: () => busy, querySelector: () => busy ? {} : null });
  const root = make("s14-live", "Open receipt in original thread", true), card = make("s14-inline-work", "Running");
  const current = new Map([[root.id, root], [card.id, card]]), fresh = new Map([[root.id, make(root.id, "Fresh thread")], [card.id, make(card.id, "Result and pending decision")]]);
  const page = (items: typeof current, live: boolean) => ({
    documentElement: { dataset: {} }, body: {}, activeElement: {}, getElementById: (id: string) => items.get(id) ?? null,
    querySelectorAll: (selector: string) => selector === "[data-inline-work]" ? [items.get(card.id)] : [], querySelector: (selector: string) => selector === "[data-live]" && live ? {} : null,
  });
  const ticks: Array<() => Promise<void>> = [];
  runInNewContext(source, { document: page(current, true), location: { href: "http://localhost:3001/chats/C", hash: "" }, DOMParser: class { parseFromString() { return page(fresh, false); } }, fetch: async () => ({ ok: true, text: async () => "page" }), setTimeout: (callback: () => Promise<void>) => ticks.push(callback) });
  await ticks.shift()!(); expect(card.innerHTML).toBe("Result and pending decision"); expect(root.innerHTML).toBe("Open receipt in original thread"); expect(ticks).toHaveLength(1);
});
