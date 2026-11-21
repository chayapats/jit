import { expect, test } from "bun:test";
import { emptyMobileConfiguration, mobileConfiguration, mobileLink } from "../src/s16/mobile/configuration";
import { mobileServiceId } from "../src/s16/mobile/transport";
import { MobileDrafts, checkMobileIntent, mobileIntent } from "../src/s16/mobile/drafts";
import { mobileFixture } from "./fixtures/s16-mobile";

test("native configuration verifies full-origin bindings and never admits a credential or unknown selected service", async () => {
  expect(await mobileConfiguration(null)).toBe(emptyMobileConfiguration);
  const origin = "https://jit.example:8443", id = await mobileServiceId(origin);
  const valid = { contract: "s16-mobile-configuration/v1", locale: "en", selected: id, services: [{ id, origin }] } as const;
  expect(await mobileConfiguration(JSON.stringify(valid))).toEqual(valid);
  for (const malformed of [
    { ...valid, cookie: "controlled-secret" }, { ...valid, selected: "0".repeat(64) }, { ...valid, locale: "unknown" },
    { ...valid, services: [{ id, origin: "https://jit.example:8444" }] }, { ...valid, services: [{ id, origin: "https://jit.example:8443.evil.example" }] },
    { ...valid, services: [{ id, origin: "https://owner:password@jit.example:8443" }] }, { ...valid, services: [{ id, origin: "http://jit.example:8443" }] },
    { ...valid, services: [{ id, origin }, { id, origin }] }, { ...valid, services: [{ id, origin, password: "controlled-secret" }] },
  ]) await expect(mobileConfiguration(JSON.stringify(malformed))).rejects.toMatchObject({ code: "mobile_configuration_invalid" });
});

test("native deep links are opaque navigation only and refuse URL normalization, encoded tricks and authority arguments", () => {
  const service = "a".repeat(64), base = `jit://open/${service}/conversation`;
  expect(mobileLink(base)).toEqual({ service, conversationId: "conversation", requestId: null });
  expect(mobileLink(base + "/request")).toEqual({ service, conversationId: "conversation", requestId: "request" });
  for (const candidate of [base + "?approve=1", base + "#approve", base + "/", base + "/request/extra", base + "/../replacement", base + "/%2e%2e/replacement", base.replace("conversation", "%63onversation"), base.replace("jit:", "https:"), base.replace("open/", "owner@open/"), base.replace("open/", "open:443/"), " " + base, base + "\n", base + "/decision/approve", "jit://open/https://evil.example/conversation"]) expect(mobileLink(candidate)).toBeNull();
});

test("same-session RAM draft survives an OS-sheet background, while target changes reject even a return to the old conversation", async () => {
  const m = await mobileFixture(), drafts = new MobileDrafts();
  try {
    await m.session.restore(); await m.session.selectConversation("original"); const intent = mobileIntent(m.session);
    drafts.change(intent, () => ({ text: "Controlled unsent private draft", files: [] }));
    // Picker cancellation itself performs no draft mutation, so the exact unsent text remains.
    expect(drafts.get(intent.scope, intent.conversationId).text).toBe("Controlled unsent private draft");
    m.session.background(); expect(() => checkMobileIntent(intent)).toThrow("mobile_binding_changed");
    await m.session.restore(); checkMobileIntent(intent); expect(drafts.get(intent.scope, intent.conversationId).text).toBe("Controlled unsent private draft");
    await m.session.selectConversation("other"); await m.session.selectConversation("original");
    expect(() => drafts.change(intent, () => ({ text: "A stale picker must not replace the draft", files: [] }))).toThrow("mobile_binding_changed");
    expect(drafts.get(intent.scope, intent.conversationId).text).toBe("Controlled unsent private draft"); expect(m.f.vmCalls).toEqual([]);
  } finally { await m.close(); }
});
