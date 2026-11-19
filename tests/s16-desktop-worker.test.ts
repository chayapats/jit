import { expect, test } from "bun:test";
import { buildDesktopPackage, type DesktopPackage } from "../src/s16/desktop/release";
import { s16WorkerScript } from "../src/s16/web/worker";

const origin = "https://jit.example.test", marker = origin + "/s16/.desktop-complete", prefix = "jit-s16-client-v1-";
const pack = (revision: string) => buildDesktopPackage({ script: `/* public ${revision} */`, style: `body{--revision:${revision}}`, worklet: "/* public audio */", icons: ([192, 512] as const).map(size => ({ size, body: new Uint8Array([size / 2]) })) });
type Fault = "offline" | "truncated" | "corrupt" | "redirect" | "mime" | null;

/** Cache Storage fixture preserves real Response stream/clone semantics and resolves relative keys like a browser. */
function storage() {
  const rows = new Map<string, Map<string, Response>>(); let clock = 1000, putFault = false;
  const key = (value: string | Request) => new URL(typeof value === "string" ? value : value.url, origin).href;
  const caches = {
    async keys() { return [...rows.keys()]; }, async delete(name: string) { return rows.delete(name); },
    async open(name: string) {
      let row = rows.get(name); if (!row) { row = new Map(); rows.set(name, row); } const members = row;
      return {
        async match(path: string | Request) { return members.get(key(path))?.clone(); },
        async put(path: string | Request, response: Response) { if (putFault && !name.includes("-staging-") && key(path) !== marker) throw new Error("controlled_power_loss"); members.set(key(path), response.clone()); },
        async delete(path: string | Request) { return members.delete(key(path)); },
      };
    },
  };
  return { rows, caches, date: { now: () => ++clock }, set putFault(value: boolean) { putFault = value; } };
}

function worker(pkg: DesktopPackage, shared = storage()) {
  const listeners = new Map<string, ((event: any) => void)[]>(), fetched: { url: string; options: RequestInit }[] = [];
  let fault: Fault = null, skipWaiting = 0, claims = 0;
  const self = { location: new URL(origin + "/s16/sw.js"), navigator: { language: "en" }, clients: { async claim() { claims++; } },
    addEventListener(type: string, listener: (event: any) => void) { const list = listeners.get(type) ?? []; list.push(listener); listeners.set(type, list); }, skipWaiting() { skipWaiting++; } };
  const fetch = async (url: string, options: RequestInit) => {
    fetched.push({ url, options }); if (fault === "offline") throw new Error("controlled_offline");
    const asset = pkg.release.assets.find(asset => new URL(asset.path, origin).href === url)!;
    let bytes = pkg.bodies.get(asset.path)!;
    if (fault === "truncated") bytes = bytes.slice(0, -1);
    if (fault === "corrupt") bytes = new Uint8Array(bytes.map(byte => byte ^ 1));
    const response = new Response(bytes, { headers: { "Content-Type": fault === "mime" ? "text/plain" : asset.contentType } });
    if (fault === "redirect") Object.defineProperty(response, "redirected", { value: true });
    return response;
  };
  new Function("self", "caches", "crypto", "fetch", "Date", s16WorkerScript({ release: pkg.release, csp: "default-src 'none'; script-src 'self'" }))(self, shared.caches, crypto, fetch, shared.date);
  const event = async (type: string, value: Record<string, unknown> = {}) => {
    const waiting: Promise<unknown>[] = []; for (const listener of listeners.get(type) ?? []) listener({ ...value, waitUntil(promise: Promise<unknown>) { waiting.push(promise); } });
    await Promise.all(waiting);
  };
  return { shared, fetched, set fault(value: Fault) { fault = value; }, get skipWaiting() { return skipWaiting; }, get claims() { return claims; }, install: () => event("install"), activate: () => event("activate"),
    async request(path: string, options: { method?: string; mode?: string } = {}): Promise<Response | null> { const response: { current: Promise<Response> | null } = { current: null }; await event("fetch", { request: { url: new URL(path, origin).href, method: options.method ?? "GET", mode: options.mode ?? "navigate" }, respondWith(value: Promise<Response>) { response.current = value; } }); return response.current ? await response.current : null; },
    async status(source: string) { const posted: unknown[] = []; await event("message", { source: { url: source }, data: { type: "jit-desktop-status" }, ports: [{ postMessage(value: unknown) { posted.push(value); }, close() {} }] }); return posted; },
  };
}

test("only a complete hash-verified public package commits; navigation and code select that one release", async () => {
  const pkg = pack("first"), w = worker(pkg); await w.install(); await w.activate();
  expect(w.skipWaiting).toBe(0); expect(w.claims).toBe(1); expect(w.fetched).toHaveLength(pkg.release.assets.length);
  for (const call of w.fetched) expect(call.options).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
  const cache = w.shared.rows.get(prefix + pkg.release.id)!;
  expect(cache.size).toBe(pkg.release.assets.length + 1); expect(cache.has(marker)).toBe(true);
  for (const path of ["/s16/", "/s16/chat/c", "/s16/computers", "/s16/bots/new"]) expect(await (await w.request(path))!.text()).toContain(pkg.release.assets.find(asset => asset.path.endsWith("client.js"))!.path);
  const js = pkg.release.assets.find(asset => asset.path.endsWith("client.js"))!;
  expect(await (await w.request(js.path, { mode: "cors" }))!.text()).toBe("/* public first */");
  expect(await w.status(origin + "/s16/chat/c")).toEqual([{ contract: "s16-desktop-status/v1", id: pkg.release.id, ready: true }]);
  expect(await w.status("https://evil.test/s16/")).toEqual([]);
});

test.each(["offline", "truncated", "corrupt", "redirect", "mime"] as const)("a %s update leaves the complete active client and private state untouched", async fault => {
  const first = pack("first"), a = worker(first); await a.install(); await a.activate();
  const next = pack("next"), b = worker(next, a.shared); b.fault = fault;
  await expect(b.install()).rejects.toThrow();
  expect(b.shared.rows.get(prefix + first.release.id)!.has(marker)).toBe(true);
  expect([...b.shared.rows.keys()].some(name => name.includes("-staging-"))).toBe(false);
  expect(b.shared.rows.get(prefix + next.release.id)?.has(marker) ?? false).toBe(false);
  expect(await (await a.request("/s16/"))!.text()).toContain(first.release.assets.find(asset => asset.path.endsWith("client.js"))!.path);
  expect(a.skipWaiting + b.skipWaiting).toBe(0);
});

test("interrupted final copy never commits; retry repairs it, activation retains a preceding complete package", async () => {
  const first = pack("first"), a = worker(first); await a.install(); await a.activate();
  const next = pack("next"), b = worker(next, a.shared); b.shared.putFault = true;
  await expect(b.install()).rejects.toThrow("controlled_power_loss");
  expect(b.shared.rows.get(prefix + next.release.id)?.has(marker) ?? false).toBe(false);
  b.shared.putFault = false; await b.install(); await b.activate();
  expect([...b.shared.rows.keys()].sort()).toEqual([prefix + first.release.id, prefix + next.release.id].sort());
  const third = pack("third"), c = worker(third, a.shared); await c.install(); await c.activate();
  expect([...c.shared.rows.keys()].sort()).toEqual([prefix + next.release.id, prefix + third.release.id].sort());
});

test("private and adversarial requests bypass the public cache; tampered bytes never execute or become a trusted fallback", async () => {
  const pkg = pack("first"), w = worker(pkg); await w.install(); const requests = w.fetched.length;
  for (const path of ["/api/s16/client/session", "/api/s16/client/requests/r/artifacts/f", "/s16/voice-worklet.js", "/s16/chat/c?approve=yes", "/s16/chat/c/decide", "/s16/unknown", "/s160", "https://evil.test/s16/", "/owner/reset", "/work"]) expect(await w.request(path)).toBeNull();
  expect(await w.request("/s16/", { method: "POST" })).toBeNull(); expect(w.fetched).toHaveLength(requests);
  const js = pkg.release.assets.find(asset => asset.path.endsWith("client.js"))!, row = w.shared.rows.get(prefix + pkg.release.id)!;
  row.set(origin + js.path, new Response("/* attacker */", { headers: { "Content-Type": js.contentType } })); w.fault = "offline";
  const failed = await w.request("/s16/"); expect(failed!.status).toBe(503); expect(await failed!.text()).not.toContain("attacker");
  expect(await w.status(origin + "/s16/")).toEqual([{ contract: "s16-desktop-status/v1", id: pkg.release.id, ready: false }]);
  w.fault = null; expect((await w.request("/s16/"))!.status).toBe(200);
  expect(await (await w.request(js.path, { mode: "cors" }))!.text()).toBe("/* public first */");
  for (const value of w.shared.rows.values()) for (const url of value.keys()) expect(new URL(url).pathname.startsWith("/s16/assets/") || url === marker).toBe(true);
});
