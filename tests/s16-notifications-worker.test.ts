import { expect, test } from "bun:test";
import { s16WorkerScript } from "../src/s16/web/worker";

/** Runs the served worker script against a fake ServiceWorkerGlobalScope and records what it does. */
function worker(language = "th-TH") {
  const listeners = new Map<string, (event: unknown) => void>(), shown: { title: string; options: Record<string, unknown> }[] = [], opened: string[] = [], focused: string[] = [], posted: unknown[] = [];
  const store = new Map<string, string>();
  const windows: { url: string; focus(): Promise<unknown>; postMessage(message: unknown): void }[] = [];
  const self = {
    location: new URL("https://jit.example.test/s16/sw.js"), navigator: { language },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    skipWaiting() {}, registration: { async showNotification(title: string, options: Record<string, unknown>) { shown.push({ title, options }); } },
    clients: { async claim() {}, async matchAll() { return windows; }, async openWindow(url: string) { opened.push(url); return null; } },
  };
  const caches = { async open() { return { async match(key: string) { return store.has(key) ? new Response(store.get(key)) : undefined; }, async put(key: string, response: Response) { store.set(key, await response.text()); } }; } };
  new Function("self", "caches", s16WorkerScript())(self, caches);
  const dispatch = async (type: string, event: Record<string, unknown>) => { let done: Promise<unknown> = Promise.resolve(); listeners.get(type)!({ ...event, waitUntil(promise: Promise<unknown>) { done = promise; } }); await done; };
  const push = (data: unknown) => dispatch("push", { data: data === null ? null : { json: () => typeof data === "string" ? JSON.parse(data) : data } });
  const click = (path: unknown) => dispatch("notificationclick", { notification: { data: { path }, close() {} } });
  return { listeners, shown, opened, focused, posted, windows, push, click, dispatch, store };
}
const id = "nt_" + "a".repeat(32);

test("the worker shows only localized generic text and tags each notice with its durable ID", async () => {
  const w = worker("th-TH");
  expect([...w.listeners.keys()].sort()).toEqual(["activate", "install", "message", "notificationclick", "push"]);
  await w.push({ v: 1, id, kind: "needs_you", path: "/s16/chat/conversation_1" });
  expect(w.shown[0]).toEqual({ title: "จิตรอคุณอยู่", options: { body: "เปิดบทสนทนาเพื่อดูและตัดสินใจ", tag: id, lang: "th", data: { path: "/s16/chat/conversation_1" }, icon: expect.stringMatching(/^\/assets\/icon-192\.[a-f0-9]{16}\.png$/) } });
  // The page's language choice is stored on the device and wins over the browser language.
  await w.dispatch("message", { data: { type: "jit-locale", locale: "en" }, source: { url: "https://jit.example.test/s16" } });
  await w.push({ v: 1, id, kind: "result", path: "/s16/chat/conversation_1" });
  expect(w.shown[1]).toMatchObject({ title: "Jit finished", options: { body: "Open the conversation to see the result.", lang: "en", tag: id } });
  await w.dispatch("message", { data: { type: "jit-locale", locale: "fr" }, source: { url: "https://jit.example.test/s16" } });
  await w.dispatch("message", { data: { type: "jit-locale", locale: "th" }, source: { url: "https://evil.example/" } });
  await w.push({ v: 1, id, kind: "routine", path: "/s16/routines/rt_1" });
  expect(w.shown[2]).toMatchObject({ title: "Routine update", options: { data: { path: "/s16/routines/rt_1" } } });
  // Anything malformed still shows a notice, but only the generic one pointing at the app.
  for (const bad of [null, "not json", { v: 2, id, kind: "result", path: "/s16" }, { v: 1, id, kind: "pay", path: "/s16" }, { v: 1, id, kind: "result", path: "https://evil.example/s16" }, { v: 1, id: "x", kind: "result", path: "/s16" }, { v: 1, id, kind: "result", path: "/s16/chat/../../owner" }]) {
    await w.push(bad);
    expect(w.shown.at(-1)).toMatchObject({ title: "Jit", options: { tag: "jit-generic", data: { path: "/s16" } } });
  }
  expect(worker("en-US").listeners.size).toBe(5);
  const english = worker("en-US"); await english.push({ v: 1, id, kind: "needs_you", path: "/s16" });
  expect(english.shown[0]!.title).toBe("Jit needs you");
});

test("a click focuses the conversation already open or opens it, and never leaves the app origin", async () => {
  const w = worker();
  await w.click("/s16/chat/conversation_1");
  expect(w.opened).toEqual(["https://jit.example.test/s16/chat/conversation_1"]);
  const focused: string[] = [], messages: unknown[] = [];
  w.windows.push({ url: "https://jit.example.test/s16/chat/conversation_1", async focus() { focused.push(this.url); return this; }, postMessage(message) { messages.push(message); } });
  await w.click("/s16/chat/conversation_1");
  expect(focused).toEqual(["https://jit.example.test/s16/chat/conversation_1"]); expect(messages).toEqual([{ type: "jit-notice-open", path: "/s16/chat/conversation_1" }]);
  expect(w.opened).toHaveLength(1);
  for (const bad of ["https://evil.example/", "//evil.example/s16", "/settings", 42]) await w.click(bad);
  expect(w.opened.slice(1)).toEqual(Array(4).fill("https://jit.example.test/s16"));
});
