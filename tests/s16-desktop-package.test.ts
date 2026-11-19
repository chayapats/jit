import { expect, test } from "bun:test";
import { buildDesktopPackage, desktopDocument, desktopLimits } from "../src/s16/desktop/release";
import { createS16WebHandler } from "../src/s16/web/handler";
import { desktopLaunchUrl, desktopService } from "../src/s16/desktop/boundary";

test("public package identity covers every byte and retains the exact neutral desktop manifest", () => {
  const input = { script: "/* public client */", style: "body{}", worklet: "/* audio */", icons: ([192, 512] as const).map(size => ({ size, body: new Uint8Array([size / 2]) })) };
  const a = buildDesktopPackage(input), b = buildDesktopPackage(input);
  expect(a.release).toEqual(b.release); expect(a.release.assets).toHaveLength(8);
  for (const asset of a.release.assets) {
    const bytes = a.bodies.get(asset.path)!;
    expect(bytes.byteLength).toBe(asset.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    expect(asset.path).toContain(asset.sha256);
  }
  const manifest = JSON.parse(new TextDecoder().decode(a.bodies.get(a.release.manifest)));
  expect(manifest).toMatchObject({ id: "/s16/", start_url: "/s16/", scope: "/s16/", display: "standalone" });
  for (const key of ["protocol_handlers", "file_handlers", "share_target", "scope_extensions"]) expect(manifest[key]).toBeUndefined();
  for (const lang of ["en", "th"] as const) {
    const html = new TextDecoder().decode(a.bodies.get(a.release.shells[lang]));
    expect(html).toContain(`lang="${lang}"`); expect(html).toContain(a.release.manifest); expect(html).not.toContain("csrf");
  }
  expect(buildDesktopPackage({ ...input, script: input.script + "// revision" }).release.id).not.toBe(a.release.id);
  expect(() => buildDesktopPackage({ ...input, script: "x".repeat(desktopLimits.assetBytes + 1) })).toThrow("desktop_asset_limit");
});

test("desktop document paths never encode action/query/protocol/deep-link commands", () => {
  for (const path of ["/s16", "/s16/", "/s16/chat/conversation", "/s16/bots/new", "/s16/memory", "/s16/computers"]) expect(desktopDocument(path)).toBe(true);
  for (const path of ["https://evil.test/s16", "//evil.test/s16", "javascript:alert(1)", "/s16?approve=yes", "/s16/chat/a/decide", "/s16/chat/../settings", "/api/s16/client/session", "/work", "/s160", "/s16/unknown", "/s16/chat/%2fowner"]) expect(desktopDocument(path)).toBe(false);
});

test("launcher service identities and deep links cannot select credentials, arbitrary protocols or another origin", () => {
  expect(desktopService("https://jit.example.test/s16/")).toBe("https://jit.example.test");
  expect(desktopService("http://127.0.0.1:1234")).toBe("http://127.0.0.1:1234");
  for (const value of ["http://jit.example.test", "https://user:password@jit.example.test", "file:///private/data", "javascript:alert(1)", "https://jit.example.test?token=x", "https://jit.example.test#next", "https://jit.example.test/other", "https://jit.example.test\\@evil.test/"]) expect(() => desktopService(value)).toThrow("desktop_service_invalid");
  expect(desktopLaunchUrl("https://jit.example.test", "/s16/chat/known")).toBe("https://jit.example.test/s16/chat/known");
  for (const link of ["https://evil.test/s16/", "https://jit.example.test:8443/s16/", "//evil.test/s16/", "/s16?approve=yes", "/s16/chat/c/decide", "file:///s16/"]) expect(() => desktopLaunchUrl("https://jit.example.test", link)).toThrow("desktop_link_invalid");
});

test("actual bundle ships public immutable inventory but keeps session, legacy assets and route guards", async () => {
  let auth = 0;
  const handler = await createS16WebHandler(async () => { auth++; return new Response("", { status: 401 }); }, { origin: "https://jit.example.test" });
  const request = (path: string, method = "GET", host = "jit.example.test") => handler(new Request("https://jit.example.test" + path, { method, headers: { host } }));
  const response = await request("/s16/desktop-release.json"), release = await response.json();
  expect(response.status).toBe(200); expect(release.contract).toBe("s16-desktop-release/v1"); expect(auth).toBe(0);
  for (const asset of release.assets) {
    const response = await request(asset.path); expect(response.status).toBe(200);
    const bytes = await response.bytes(); expect(bytes.length).toBe(asset.bytes);
    expect(new Bun.CryptoHasher("sha256").update(bytes).digest("hex")).toBe(asset.sha256);
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect((await request(asset.path + "?x=1")).status).toBe(405); expect((await request(asset.path, "POST")).status).toBe(405);
    if (asset.path.endsWith("client.js")) { const text = new TextDecoder().decode(bytes); expect(text).toContain("Apache License"); expect(text).toContain("Rakazo"); }
  }
  expect(auth).toBe(0);
  for (const path of ["/s16", "/s16/client.js", "/s16/voice-worklet.js"]) expect((await request(path)).status).toBe(401);
  expect(auth).toBe(3);
  expect((await request("/s16/desktop-release.json", "GET", "evil.test")).status).toBe(403);
  expect((await request("/s16/assets/" + "a".repeat(64) + "/client.js")).status).toBe(404);
  const worker = await request("/s16/sw.js"); expect(worker.headers.get("content-security-policy")).toContain("connect-src 'self'");
  expect(await worker.text()).toContain(release.id);
});
