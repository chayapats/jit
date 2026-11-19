import { expect, test } from "bun:test";
import { MobileNotifications, type MobileNotificationOs } from "../src/s16/mobile/notifications";
import { mobileFixture } from "./fixtures/s16-mobile";

async function fixture() {
  let available = true, token = "a".repeat(64), requests = 0, tokenReads = 0;
  const m = await mobileFixture(options => ({ ...options, nativeNotifications: { providers: [{ kind: "apns", status: () => ({ provider: "apns", available, code: available ? null : "native_push_credentials_unavailable" }), async send() { throw Error("No notice should be delivered by these client controls"); } }] } }));
  await m.session.restore(); let permission: Awaited<ReturnType<MobileNotificationOs["permission"]>> = "granted";
  const os: MobileNotificationOs = { provider: "apns", async active() {}, async permission() { return permission; }, async requestPermission() { requests++; return permission; }, async token() { tokenReads++; return token; } };
  const store = { async get(key: string) { return m.records.get(key) ?? null; }, async set(key: string, value: string) { m.records.set(key, value); }, async delete(key: string) { m.records.delete(key); } };
  const control = new MobileNotifications(m.session, store, os);
  return { m, os, store, control, get requests() { return requests; }, get tokenReads() { return tokenReads; }, set permission(value: typeof permission) { permission = value; }, set token(value: string) { token = value; }, set available(value: boolean) { available = value; } };
}

test("explicit native opt-in persists protected intent before POST and read-only restart never registers again", async () => {
  const f = await fixture(); let posts = 0;
  try {
    f.m.intercept = request => {
      if (new URL(request.url).pathname.endsWith("/subscribe")) {
        posts++; const saved = [...f.m.records.values()].map(value => JSON.parse(value)).find(value => value.v === 1);
        expect(saved).toMatchObject({ token: "a".repeat(64), intent: "subscribing", service: f.m.service });
      }
      return null;
    };
    await f.control.refresh(); expect(f.control.projection.state).toBe("off"); expect(f.requests).toBe(0);
    await Promise.all([f.control.enable("th"), f.control.enable("th")]); expect(posts).toBe(1); expect(f.requests).toBe(1);
    expect(f.control.projection).toEqual({ state: "enabled", busy: false, canDisable: true }); expect(JSON.stringify(f.control.projection)).not.toContain("a".repeat(64));
    const restored = new MobileNotifications(f.m.session, f.store, f.os); await restored.refresh(); expect(restored.projection.state).toBe("enabled"); expect(posts).toBe(1); expect(f.requests).toBe(1);
    await restored.disable(); await restored.refresh(); expect(restored.projection.state).toBe("off"); expect(posts).toBe(1); expect(f.m.f.vmCalls).toEqual([]);
  } finally { await f.m.close(); }
});

test("unknown subscribe response reads original hash after reauthentication and never replays a POST", async () => {
  const f = await fixture(); let posts = 0;
  try {
    f.m.intercept = async request => {
      if (new URL(request.url).pathname.endsWith("/subscribe")) { posts++; await f.m.f.service.fetch(request); return new Response("{", { headers: { "content-type": "application/json" } }); }
      return null;
    };
    await expect(f.control.enable("en")).rejects.toBeDefined(); expect(f.control.projection.state).toBe("uncertain"); expect(posts).toBe(1);
    expect([...f.m.records.values()].some(value => value.includes('"intent":"subscribing"'))).toBe(true);
    f.m.intercept = request => { if (request.method === "POST") posts++; return null; };
    await f.m.session.restore(); const restored = new MobileNotifications(f.m.session, f.store, f.os); await restored.refresh();
    expect(restored.projection.state).toBe("enabled"); expect(posts).toBe(1); expect(f.m.f.vmCalls).toEqual([]);
  } finally { await f.m.close(); }
});

test("native OS dialog can background safely but A to B to A selection rejects its late grant before storage or POST", async () => {
  const f = await fixture(); let resolve!: (value: "granted") => void, posts = 0;
  try {
    await f.m.session.selectConversation("original");
    f.os.requestPermission = () => { f.m.session.background(); return new Promise(done => { resolve = done; }); };
    f.m.intercept = request => { if (request.method === "POST") posts++; return null; };
    const enabling = f.control.enable("th"); const result = enabling.then(() => null, error => error);
    while (!resolve) await new Promise(done => setTimeout(done, 1));
    await f.m.session.restore(); await f.m.session.selectConversation("other"); await f.m.session.selectConversation("original"); resolve("granted");
    expect(await result).toMatchObject({ code: "mobile_response_stale" }); expect(posts).toBe(0); expect(f.tokenReads).toBe(0);
    expect([...f.m.records.keys()].some(key => key.startsWith("jit.mobile.notifications"))).toBe(false);
  } finally { await f.m.close(); }
});

test("denial and unavailable setup never acquire a token; storage failure sends no subscription", async () => {
  const f = await fixture(); let posts = 0;
  try {
    f.m.intercept = request => { if (request.method === "POST") posts++; return null; };
    f.permission = "denied"; await f.control.enable("en"); expect(f.control.projection.state).toBe("denied"); expect(f.tokenReads).toBe(0); expect(posts).toBe(0);
    f.available = false; await expect(f.control.enable("en")).rejects.toMatchObject({ code: "mobile_notification_unavailable" }); expect(f.requests).toBe(1); expect(f.tokenReads).toBe(0);
    f.available = true; f.permission = "granted";
    f.store.set = async () => { throw Error("Controlled unavailable SecureStore"); };
    await expect(f.control.enable("en")).rejects.toBeDefined(); expect(posts).toBe(0);
  } finally { await f.m.close(); }
});

test("token rotation and revoked permission cannot display enabled; explicit disable removes the original binding", async () => {
  const f = await fixture(); let posts = 0;
  try {
    f.m.intercept = request => { if (new URL(request.url).pathname.endsWith("/subscribe")) posts++; return null; };
    await f.control.enable("th"); f.permission = "provisional"; await f.control.refresh(); expect(f.control.projection.state).toBe("provisional");
    f.permission = "granted"; f.token = "b".repeat(64); await f.control.refresh(); expect(f.control.projection.state).toBe("token_changed");
    await f.control.enable("th"); expect(f.control.projection.state).toBe("token_changed"); expect(posts).toBe(1);
    f.os.token = async () => { throw Error("Disable must never acquire a replacement token"); };
    await f.control.disable(); expect(f.control.projection).toEqual({ state: "off", busy: false, canDisable: false }); expect((await f.m.session.perform((client, signal) => client.nativeNotificationSettings(signal))).devices).toBe(0);
  } finally { await f.m.close(); }
});
