import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { lookupS14Asset, s14AssetUrl } from "../src/s14/web-assets";

const source = new TextDecoder().decode(lookupS14Asset(s14AssetUrl("s14.js"))!.body);
const prefix = "jit.s14.draft.installation.";
/** Runs the actual shipped enhancement asset with a fake clock, storage and typed form controls. No timers or network run. */
function browser(storage = new Map<string, string>(), options: { now?: number; room?: string; committed?: string; refused?: boolean; initial?: string; denied?: boolean; closed?: boolean } = {}) {
  const now = options.now ?? 1800000000000, room = options.room ?? "room";
  const control = (name: string, value = "", type = "text") => {
    const events = new Map<string, (event: any) => void>();
    return { name, value, type, checked: false, events, addEventListener: (kind: string, callback: (event: any) => void) => events.set(kind, callback),
      dispatchEvent(event: { type: string }) { events.get(event.type)?.(event); }, focus() {}, setSelectionRange() {} };
  };
  const fields = [control("text", options.initial ?? ""), control("completion"), control("evidence"), control("work", "on", "checkbox"), control("requestId", "fresh_retry", "hidden"), control("expectedRevision", "99", "hidden"), control("conversationId", room, "hidden"), control("bot:jit", "7", "hidden"), control("tool:computer", "on", "checkbox")];
  const field = (name: string) => fields.find(value => value.name === name)!;
  const elements = Object.assign(fields, { namedItem: field });
  const events = new Map<string, (event?: any) => void>(), windowEvents = new Map<string, (event: any) => void>();
  const status = { textContent: "", dataset: { saved: "saved", restored: "restored", unavailable: "unavailable", sensitive: "sensitive" } }, bar = { hidden: true };
  const clear = control("clear"), logout = control("logout"), send = { setAttribute() {} };
  let submits = 0, reloads = 0;
  const form = { dataset: { refused: options.refused ? "true" : "false", sendChat: "Send", sendWork: "Start" } as Record<string, string>, elements,
    querySelector(selector: string): any { return selector === "textarea" ? field("text") : selector === "input[name=work]" ? field("work") : selector === ".s-send" ? send : selector === "[data-draft-status]" ? status : selector === "[data-draft-bar]" ? bar : selector === "[data-draft-clear]" ? clear : null; },
    addEventListener(kind: string, callback: (event?: any) => void) { events.set(kind, callback); }, requestSubmit() { submits++; events.get("submit")?.(); } };
  const heldText = { textContent: "" }, held = { hidden: true, querySelector: () => heldText };
  const root = { dataset: { browserKey: "installation", committed: options.committed ?? "", conversation: room } };
  const document = { documentElement: { dataset: {} }, body: {}, activeElement: null,
    querySelectorAll(selector: string) { return selector === "[data-composer]" && !options.closed ? [form] : []; },
    querySelector(selector: string): any { return selector === ".s-app[data-browser-key]" ? root : selector === "[data-composer]" && !options.closed ? form : selector === 'form[action="/s14/logout"]' ? logout : selector === "[data-draft-held]" ? held : null; }, getElementById() { return null; } };
  runInNewContext(source, { document, location: { hash: "", reload() { reloads++; } }, window: { addEventListener(kind: string, callback: (event: any) => void) { const previous = windowEvents.get(kind); windowEvents.set(kind, event => { previous?.(event); callback(event); }); } }, Event: class { constructor(public type: string) {} }, Date: class extends Date { static override now() { return now; } },
    localStorage: { get length() { if (options.denied) throw Error("denied"); return storage.size; }, key: (i: number) => [...storage.keys()][i] ?? null,
      getItem(key: string) { if (options.denied) throw Error("denied"); return storage.get(key) ?? null; }, setItem(key: string, value: string) { if (options.denied) throw Error("denied"); storage.set(key, value); }, removeItem(key: string) { storage.delete(key); } },
    setTimeout() { throw Error("unexpected timer"); }, fetch() { throw Error("unexpected network"); } });
  return { field, form, events, windowEvents, storage, status, bar, held, heldText, clear, logout, get submits() { return submits; }, get reloads() { return reloads; } };
}
const saved = (text: string, changes = {}) => JSON.stringify({ text, completion: "Finish this", evidence: "Read this", updatedAt: 1800000000000, requestId: null, ...changes });

test("reload restores only text in the same conversation, never authority, work mode or a submission", () => {
  const first = browser(); first.field("text").value = "Draft in English and Thai"; first.field("work").checked = true; first.field("tool:computer").checked = true;
  first.events.get("input")!();
  const record = JSON.parse(first.storage.get(prefix + "room")!);
  expect(Object.keys(record).sort()).toEqual(["completion", "evidence", "requestId", "text", "updatedAt"]);
  const reloaded = browser(first.storage);
  expect(reloaded.field("text").value).toBe("Draft in English and Thai"); expect(reloaded.field("work").checked).toBe(false); expect(reloaded.field("tool:computer").checked).toBe(false);
  expect(reloaded.field("requestId").value).toBe("fresh_retry"); expect(reloaded.field("expectedRevision").value).toBe("99"); expect(reloaded.submits).toBe(0);
  expect(browser(first.storage, { room: "other" }).field("text").value).toBe("");
  expect(browser(new Map()).field("text").value).toBe("");
});

test("the exact 30-day boundary expires a draft, while reload does not renew its last-edit time", () => {
  const storage = new Map([[prefix + "room", saved("Keep")]]), ttl = 30 * 86400000;
  expect(browser(storage, { now: 1800000000000 + ttl - 1 }).field("text").value).toBe("Keep");
  expect(JSON.parse(storage.get(prefix + "room")!).updatedAt).toBe(1800000000000);
  expect(browser(storage, { now: 1800000000000 + ttl }).field("text").value).toBe(""); expect(storage.size).toBe(0);
});

test("only a matching committed receipt clears a submitted draft; refusal and transport uncertainty keep it", () => {
  const storage = new Map([[prefix + "room", saved("Keep")]]), first = browser(storage);
  first.events.get("submit")!(); expect(JSON.parse(storage.get(prefix + "room")!).requestId).toBe("fresh_retry");
  expect(browser(storage, { committed: "other_request" }).field("text").value).toBe("Keep");
  const refused = browser(storage, { refused: true, initial: "Server-kept text" }); expect(refused.field("text").value).toBe("Server-kept text");
  expect(browser(storage, { committed: "fresh_retry" }).field("text").value).toBe(""); expect(storage.size).toBe(0);
});

test("poisoned, future, oversized and authority-bearing storage records are discarded", () => {
  for (const value of ["broken json", "null", saved("text", { updatedAt: 1800000000001 }), saved("x".repeat(16385)), saved("text", { work: true }), saved("text", { expectedRevision: 1 })]) {
    const storage = new Map([[prefix + "room", value]]), page = browser(storage);
    expect(page.field("text").value).toBe(""); expect(storage.size).toBe(0); expect(page.submits).toBe(0);
  }
});

test("credential shapes are not saved and storage denial leaves typing and ordinary submission usable", () => {
  for (const text of ["Bearer example-not-a-real-secret", "password=fixture-only-password", "ghp_" + "a".repeat(24)]) {
    const page = browser(); page.field("text").value = text; page.events.get("input")!();
    expect(page.storage.size).toBe(0); expect(page.status.textContent).toBe("sensitive"); expect(page.field("text").value).toBe(text);
  }
  const page = browser(new Map(), { denied: true }); page.field("text").value = "Still typing"; page.events.get("input")!();
  expect(page.status.textContent).toBe("unavailable"); page.form.requestSubmit(); expect(page.submits).toBe(1); expect(page.field("text").value).toBe("Still typing");
});

test("closed Bots show draft text without a composer, explicit clear/logout remove local drafts without evicting other unexpired text", () => {
  const storage = new Map([[prefix + "room", saved("Closed draft")]]), closed = browser(storage, { closed: true });
  expect(closed.heldText.textContent).toBe("Closed draft"); expect(closed.held.hidden).toBe(false); expect(closed.submits).toBe(0);
  const page = browser(storage); page.clear.events.get("click")!({}); expect(storage.size).toBe(0); expect(page.field("text").value).toBe("");
  for (let i = 0; i < 40; i++) storage.set(prefix + i, saved("Draft", { updatedAt: 1800000000000 - i }));
  storage.set("jit.s14.draft.old-owner.room", saved("Old owner")); browser(storage); expect(storage.size).toBe(40);
  page.logout.events.get("submit")!({}); expect(storage.size).toBe(0);
});

test("an IME confirmation never submits, and an explicit history return resets Work", () => {
  const page = browser(), event = { key: "Enter", isComposing: true, shiftKey: false, preventDefault() { throw Error("composition must remain native"); } };
  page.field("text").value = "IME draft"; page.field("text").events.get("keydown")!(event); expect(page.submits).toBe(0);
  page.field("work").checked = true; page.windowEvents.get("pageshow")!({ persisted: true }); expect(page.field("work").checked).toBe(false);
});

test("Back cannot resurrect already acknowledged submitted text from the page cache", () => {
  const storage = new Map([[prefix + "room", saved("Already submitted")]]), previous = browser(storage);
  previous.field("work").checked = true; previous.events.get("submit")!();
  browser(storage, { committed: "fresh_retry" }); expect(storage.size).toBe(0);
  previous.windowEvents.get("pageshow")!({ persisted: true });
  expect(previous.field("text").value).toBe(""); expect(previous.field("work").checked).toBe(false); expect(previous.submits).toBe(0); expect(previous.reloads).toBe(1);
});
