import { expect, test } from "bun:test";
import { JitClient } from "../src/s16/client";
import { MobileTransport, mobileOrigin, mobileServiceId, type MobileFetch, type MobileSecureStore } from "../src/s16/mobile/transport";
import { composedFixture } from "./fixtures/s15-composition";

const origin = "https://jit.example.test", cookie = "fixture_mobile_session_1234567890", password = "Controlled fixture password";
function secureStore() {
  const records = new Map<string, string>(), writes: string[] = [];
  const port: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { writes.push(key); records.set(key, value); }, async delete(key) { records.delete(key); } };
  return { port, records, writes };
}
const response = (url: string, value: Response) => ({ url, status: value.status, redirected: false, body: value.body, headers: value.headers });
const login = (url: string, more: Record<string, string> = {}) => response(url, new Response(null, { status: 303, headers: { Location: "/", "Set-Cookie": "__Host-jit_s14=" + cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400; Secure", ...more } }));
async function seed(store: ReturnType<typeof secureStore>, serviceOrigin: string, value = cookie, expiresAt = Date.now() + 3600000) {
  const service = await mobileServiceId(serviceOrigin);
  store.records.set("jit.mobile.session.v1." + service, JSON.stringify({ contract: "s16-mobile-session/v1", service, token: value, expiresAt }));
}

test("mobile service selection is a canonical full origin and never an authority-bearing link", async () => {
  expect(mobileOrigin(origin + "/")).toBe(origin); expect(mobileOrigin("http://127.0.0.1:3099")).toBe("http://127.0.0.1:3099");
  for (const input of ["http://jit.example.test", "http://localhost:3099", "https://user:secret@jit.example.test", origin + "/s16", origin + "?approve=1", origin + "#cookie", "jit://open/anything", " " + origin, "https://jit.example.test:443", "https://jit.example.test/../"]) expect(() => mobileOrigin(input)).toThrow("mobile_origin_invalid");
  expect(await mobileServiceId(origin + ":444")).not.toBe(await mobileServiceId(origin));
});

test("explicit existing-ingress login keeps only an expiring origin-scoped native credential", async () => {
  const store = secureStore(), calls: { url: string; init: RequestInit }[] = [];
  const native = new MobileTransport({ origin, store: store.port, fetch: async (url, init) => { calls.push({ url, init }); return login(url); } });
  await native.signIn(password); expect(native.authenticated).toBe(true); expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(origin + "/s14/login"); expect(calls[0]!.init).toMatchObject({ method: "POST", credentials: "omit", redirect: "manual", body: JSON.stringify({ password }) });
  expect(new Headers(calls[0]!.init.headers).get("cookie")).toBeNull(); expect(new Headers(calls[0]!.init.headers).get("origin")).toBe(origin);
  expect(store.records.size).toBe(1); expect([...store.records.values()][0]).not.toContain(password);
  expect([...store.records.keys()][0]).not.toContain("jit.example.test");
  const same = new MobileTransport({ origin, store: store.port, fetch: async () => { throw Error("restore must not send a command"); } });
  expect(await same.restore()).toBe(true);
  const other = new MobileTransport({ origin: origin + ":444", store: store.port, fetch: async () => { throw Error("restore must not contact another service"); } });
  expect(await other.restore()).toBe(false); await same.forget(); expect(store.records.size).toBe(0);
});

test("malformed login cannot replace an established credential or follow a foreign redirect", async () => {
  const store = secureStore(); await seed(store, origin); const retained = [...store.records.values()][0]; let calls = 0, headers: Record<string, string> = {};
  const native = new MobileTransport({ origin, store: store.port, fetch: async (url, init) => { calls++; expect(init.redirect).toBe("manual"); return login(url, headers); } });
  await native.restore();
  for (const value of ["jit_s14=" + cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400", "__Host-jit_s14=" + cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400; Secure; Domain=jit.example.test", "__Host-jit_s14=" + cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=99999; Secure", "__Host-jit_s14=" + cookie + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400; Secure; Secure"]) {
    headers = { "Set-Cookie": value }; await expect(native.signIn(password)).rejects.toMatchObject({ code: "mobile_login_failed" }); expect([...store.records.values()][0]).toBe(retained);
  }
  headers = { Location: "https://elsewhere.example.test/collect" }; await expect(native.signIn(password)).rejects.toMatchObject({ code: "mobile_login_failed" }); expect(calls).toBe(5); expect(native.authenticated).toBe(true);
});

test("native credential failures and expiry never fall back to plaintext or another session", async () => {
  const store = secureStore(), broken: MobileSecureStore = { ...store.port, async set() { throw Error("private OS path and secret must not escape"); } };
  const native = new MobileTransport({ origin, store: broken, fetch: async url => login(url) });
  await expect(native.signIn(password)).rejects.toMatchObject({ message: "mobile_storage_unavailable" }); expect(native.authenticated).toBe(false); expect(store.records.size).toBe(0);
  await seed(store, origin, cookie, Date.now() - 1); expect(await native.restore()).toBe(false); expect(store.records.size).toBe(0);
  const service = await mobileServiceId(origin); store.records.set("jit.mobile.session.v1." + service, JSON.stringify({ contract: "s16-mobile-session/v1", service, token: cookie, expiresAt: Date.now() + 1000, unexpected: true }));
  await expect(native.restore()).rejects.toMatchObject({ code: "mobile_session_invalid" }); expect(native.authenticated).toBe(false);
});

test("authenticated native requests retain exact target, empty cookie jar and zero-follow guards", async () => {
  const store = secureStore(); await seed(store, origin); const calls: { url: string; init: RequestInit }[] = []; let substitute = "", length: string | null = null;
  const native = new MobileTransport({ origin, store: store.port, fetch: async (url, init) => { calls.push({ url, init }); return response(substitute || url, Response.json({ safe: true }, { headers: length === null ? {} : { "content-length": length } })); } });
  await native.restore();
  for (const path of [origin + ":444/api/s16/client/bootstrap", "https://other.example.test/api/s16/client/bootstrap", origin + "/s14/login", origin + "/api/s16/client-other"]) await expect(native.fetch(new Request(path))).rejects.toMatchObject({ code: "mobile_origin_invalid" });
  expect(calls).toHaveLength(0);
  const request = () => new Request(origin + "/api/s16/client/requests/work/stop", { method: "POST", headers: { Cookie: "forged=anything", Authorization: "invented", "X-CSRF-Token": "fixture-csrf" }, body: "{}" });
  expect(await (await native.fetch(request())).json()).toEqual({ safe: true }); expect(calls).toHaveLength(1);
  const sent = calls[0]!.init, sentHeaders = new Headers(sent.headers);
  expect(sent).toMatchObject({ credentials: "omit", redirect: "error" }); expect(sentHeaders.get("cookie")).toBe("__Host-jit_s14=" + cookie); expect(sentHeaders.get("authorization")).toBeNull(); expect(sentHeaders.get("origin")).toBe(origin); expect(sentHeaders.get("x-csrf-token")).toBe("fixture-csrf"); expect(sentHeaders.get("cache-control")).toBe("no-store");
  substitute = origin + ":444/api/s16/client/requests/work/stop"; await expect(native.fetch(request())).rejects.toMatchObject({ code: "mobile_response_invalid" });
  substitute = ""; length = "999999999"; await expect(native.fetch(request())).rejects.toMatchObject({ code: "mobile_response_limit" }); expect(calls).toHaveLength(3);
});

test("background cancellation settles before an uncooperative late native response and disposes it", async () => {
  const store = secureStore(); await seed(store, origin); const arrived = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let disposed = false;
  const native = new MobileTransport({ origin, store: store.port, fetch: async url => {
    arrived.resolve(); await release.promise;
    return { url, status: 200, redirected: false, headers: new Headers({ "Content-Type": "application/json" }), body: new ReadableStream({ cancel() { disposed = true; } }) };
  } });
  await native.restore(); const pending = native.fetch(new Request(origin + "/api/s16/client/bootstrap")); await arrived.promise; native.pause();
  await expect(pending).rejects.toMatchObject({ code: "mobile_request_failed" });
  await expect(native.fetch(new Request(origin + "/api/s16/client/bootstrap"))).rejects.toMatchObject({ code: "mobile_inactive" });
  release.resolve(); await new Promise(resolve => queueMicrotask(resolve)); expect(disposed).toBe(true); native.resume(); expect(native.authenticated).toBe(true);
});

test("background also aborts a stalled private body after successful headers", async () => {
  const store = secureStore(); await seed(store, origin); const reading = Promise.withResolvers<void>(); let disposed = false;
  // Disable eager stream pulling: this barrier proves the adapter reached its body read after validating headers.
  const native = new MobileTransport({ origin, store: store.port, fetch: async url => ({ url, status: 200, redirected: false, headers: new Headers({ "Content-Type": "application/json" }), body: new ReadableStream({ pull() { reading.resolve(); }, cancel() { disposed = true; } }, { highWaterMark: 0 }) }) });
  await native.restore(); const pending = native.fetch(new Request(origin + "/api/s16/client/bootstrap")); await reading.promise; native.pause();
  await expect(pending).rejects.toMatchObject({ code: "mobile_request_failed" }); expect(disposed).toBe(true);
});

test.each([401, 403])("an owning authentication refusal removes the native credential before another request (status=%s)", async status => {
  const store = secureStore(); await seed(store, origin); let requests = 0;
  const native = new MobileTransport({ origin, store: store.port, fetch: async url => { requests++; return response(url, Response.json({ error: "authentication_required" }, { status })); } });
  await native.restore(); expect((await native.fetch(new Request(origin + "/api/s16/client/bootstrap"))).status).toBe(status);
  expect(native.authenticated).toBe(false); expect(store.records.size).toBe(0);
  await expect(native.fetch(new Request(origin + "/api/s16/client/bootstrap"))).rejects.toMatchObject({ code: "mobile_session_missing" }); expect(requests).toBe(1);
});

test("invalid restored storage cannot retain an older in-memory session as a fallback", async () => {
  const store = secureStore(); await seed(store, origin);
  const native = new MobileTransport({ origin, store: store.port, fetch: async () => { throw Error("Invalid storage must not contact the service"); } });
  expect(await native.restore()).toBe(true); const key = [...store.records.keys()][0]!; store.records.set(key, "not a session record");
  await expect(native.restore()).rejects.toMatchObject({ code: "mobile_session_invalid" }); expect(native.authenticated).toBe(false);
});

test("late SecureStore completion cannot overwrite a newer service-generation decision", async () => {
  const store = secureStore(); await seed(store, origin); const retained = [...store.records.values()][0], entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = true;
  const port: MobileSecureStore = { ...store.port, async set(key, value) { if (hold) { hold = false; entered.resolve(); await release.promise; } await store.port.set(key, value); } };
  const native = new MobileTransport({ origin, store: port, fetch: async url => login(url) }); await native.restore();
  const pending = native.signIn(password); await entered.promise; native.pause(); release.resolve(); await expect(pending).rejects.toMatchObject({ code: "mobile_response_stale" });
  expect([...store.records.values()][0]).toBe(retained); native.resume(); expect(await native.restore()).toBe(true);
});

test("actual protected HTTP and shared client recover the one original command without native retries", async () => {
  let f: Awaited<ReturnType<typeof composedFixture>> | undefined;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => f ? f.service.fetch(request) : new Response(null, { status: 503 }) }), serviceOrigin = "http://127.0.0.1:" + server.port;
  const store = secureStore(); let posts = 0, lose = true;
  try {
    f = await composedFixture("default", false, undefined, options => ({ ...options, origin: serviceOrigin }));
    await seed(store, serviceOrigin, f.ownerCookie.slice("jit_s14=".length));
    const actual: MobileFetch = async (url, init) => { const result = await fetch(url, init); if (init.method === "POST") { posts++; if (lose) { lose = false; await result.body?.cancel(); throw Error("Controlled reply loss after owning admission"); } } return result; };
    const native = new MobileTransport({ origin: serviceOrigin, store: store.port, fetch: actual }); expect(await native.restore()).toBe(true);
    const client = new JitClient({ origin: serviceOrigin, fetch: request => native.fetch(request) });
    expect(await client.bootstrap()).not.toHaveProperty("csrf"); const command = client.prepareMessage("conversation", "Run the requested command in the working computer");
    await expect(client.send(command)).rejects.toMatchObject({ code: "connection_lost", outcome: "unknown", requestId: command.requestId }); await f.service.conversation.drain();
    expect((await client.request(command.requestId)).row.result).not.toBeNull(); expect(posts).toBe(1); expect(f.vmCalls.filter(value => value === "spawn")).toHaveLength(1);
    await client.send(command); await f.service.conversation.drain(); expect(posts).toBe(2); expect(f.vmCalls.filter(value => value === "spawn")).toHaveLength(1);
  } finally { await server.stop(true); await f?.close(); }
});
