import { expect, test } from "bun:test";
import { JitClient } from "../src/s16/client";
import { MobileTransport, type MobileSecureStore } from "../src/s16/mobile/transport";
import { mobileAppFixture } from "./fixtures/s16-mobile-app";

test("native login uses the real password/session handler and protected shared client without another auth protocol", async () => {
  const m = await mobileAppFixture(), records = new Map<string, string>();
  const store: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { records.set(key, value); }, async delete(key) { records.delete(key); } };
  try {
    const native = new MobileTransport({ origin: m.origin, store, fetch: (url, init) => fetch(url, init) });
    await expect(native.signIn("incorrect fixture password")).rejects.toMatchObject({ code: "mobile_login_failed" }); expect(native.authenticated).toBe(false);
    await native.signIn(m.password); expect(native.authenticated).toBe(true);
    const client = new JitClient({ origin: m.origin, fetch: request => native.fetch(request), fetchBytes: (request, bytes) => native.fetchBytes(request, bytes) });
    const boot = await client.bootstrap(); expect(boot.contract).toBe("s16-client-bootstrap/v1"); expect(boot).not.toHaveProperty("csrf"); expect(boot.capabilities.uploads.available).toBe(true);
    const input = new TextEncoder().encode("Controlled native owning file bytes"), sha256 = new Bun.CryptoHasher("sha256").update(input).digest("hex");
    const upload = await client.createUpload({ requestId: "mobile_file_once", conversationId: "conversation", name: "native.txt", bytes: input.length, sha256 });
    expect((await client.uploadBytes(upload.id, input)).receipt).toMatchObject({ id: upload.id, sha256 });
    expect(m.f.service.files!.read(m.f.owner, "conversation", { id: upload.id, sha256 }).text).toBe(new TextDecoder().decode(input));
    expect(m.f.vmCalls).toEqual([]); expect([...records.values()].join()).not.toContain(m.password);
  } finally { await m.close(); }
});
