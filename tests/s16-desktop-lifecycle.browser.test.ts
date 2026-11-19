import { expect, test } from "bun:test";
import { desktopSessionFixture } from "./fixtures/s16-desktop-session";
import { buildDesktopPackage, type DesktopRelease } from "../src/s16/desktop/release";
import { s16WorkerHeaders, s16WorkerScript } from "../src/s16/web/worker";
import { en } from "../src/i18n/en";
import type { FileUpload } from "../src/s16/files/types";

const browserTest = process.env.JIT_S16_DESKTOP_TESTS === "1" ? test : test.skip;
browserTest("native public package rejects an incomplete update, waits for window closure and preserves the owner profile", async () => {
  const native = await desktopSessionFixture("en"), { app: page } = native;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const original = await (await fetch(native.origin + "/s16/desktop-release.json")).json() as DesktopRelease;
    const bytes = async (name: string) => new Uint8Array(await (await fetch(native.origin + original.assets.find(asset => asset.path.endsWith("/" + name))!.path)).arrayBuffer());
    const [script, style, worklet, small, large] = await Promise.all([bytes("client.js"), bytes("style.css"), bytes("voice-worklet.js"), bytes("icon-192.png"), bytes("icon-512.png")]);
    // Real compiled React bytes and notices, changed only by an authored public revision comment. There is no mock
    // application shell, private cache, service upgrade or backend mutation in this delivery fixture.
    const next = buildDesktopPackage({ script: new TextDecoder().decode(script) + "\n/* controlled desktop delivery revision */", style: new TextDecoder().decode(style), worklet: new TextDecoder().decode(worklet), icons: [{ size: 192, body: small }, { size: 512, body: large }] });
    const shell = await native.session.context.request.get(native.origin + "/s16/", { maxRedirects: 0 });
    const csp = shell.headers()["content-security-policy"]!; await shell.dispose(); let corrupt = true;
    native.intercept = request => {
      const path = new URL(request.url).pathname;
      if (path === "/s16/sw.js") return new Response(s16WorkerScript({ release: next.release, csp }), { headers: s16WorkerHeaders });
      const asset = next.release.assets.find(asset => asset.path === path);
      if (!asset) return null;
      const body = next.bodies.get(path)!;
      return new Response(corrupt && path.endsWith("/client.js") ? body.slice(0, -1) : body, { headers: { "Content-Type": asset.contentType } });
    };
    const update = () => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const result = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("fixture_update_not_settled")), 10000);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing!;
          const settled = () => { if (worker.state === "installed" || worker.state === "redundant") { clearTimeout(timer); resolve(worker.state); } };
          worker.addEventListener("statechange", settled); settled();
        }, { once: true });
      });
      await registration.update(); return result;
    });
    expect(await update()).toBe("redundant");
    const failed = await page.evaluate(async () => ({ caches: await caches.keys(), waiting: !!(await navigator.serviceWorker.ready).waiting }));
    expect(failed.waiting).toBe(false); expect(failed.caches).toContain("jit-s16-client-v1-" + original.id);
    expect(failed.caches.some(name => name.includes(next.release.id))).toBe(false);
    await page.reload(); await page.locator(`[data-desktop-state="ready"]`).waitFor({ state: "attached" });
    expect(await page.locator(".desktop-version").getAttribute("title")).toBe(original.id);
    corrupt = false; expect(await update()).toBe("installed");
    await page.locator('[data-desktop-state="update"]').waitFor({ state: "attached" });
    expect(await page.locator(".desktop-version").getAttribute("title")).toBe(original.id);
    expect(await page.evaluate(async () => !!(await navigator.serviceWorker.ready).waiting)).toBe(true);
    const reopened = await native.reopen();
    await reopened.locator('[data-desktop-state="ready"]').waitFor({ state: "attached" });
    expect(await reopened.locator(".desktop-version").getAttribute("title")).toBe(next.release.id);
    const retained = await reopened.evaluate(() => caches.keys());
    expect(retained).toContain("jit-s16-client-v1-" + original.id); expect(retained).toContain("jit-s16-client-v1-" + next.release.id);
    expect(native.messages).toEqual([]); expect(native.decisions).toEqual([]); expect(native.f.vmCalls).toEqual([]);
  } finally { await native.close(); }
}, 60000);

browserTest("native install grants no media/push permission; denial and offline state remain recoverable without effects", async () => {
  const native = await desktopSessionFixture("en"), { app: page, f } = native;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const permissions = () => page.evaluate(async () => ({ notification: Notification.permission, microphone: (await navigator.permissions.query({ name: "microphone" as PermissionName })).state }));
    const initial = await permissions(); expect(initial.notification).not.toBe("granted"); expect(initial.microphone).not.toBe("granted");
    await native.session.cdp.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "denied", origin: native.origin });
    await native.session.cdp.send("Browser.setPermission", { permission: { name: "microphone" }, setting: "denied", origin: native.origin });
    await page.reload(); await page.locator(".notify-control").getByText(en["s16.notify.denied"], { exact: false }).waitFor();
    expect(await permissions()).toEqual({ notification: "denied", microphone: "denied" });
    expect(await page.locator(".notify-control").getByRole("button").count()).toBe(0);
    await native.session.cdp.send("Browser.setPermission", { permission: { name: "notifications" }, setting: "prompt", origin: native.origin });
    await page.reload(); await page.locator(".notify-control").getByRole("button", { name: en["s16.notify.enable"], exact: true }).waitFor();
    await page.goto(native.origin + "/s16/chat/conversation");
    await page.locator('input[type="file"]').setInputFiles({ name: "private-note.txt", mimeType: "text/plain", buffer: Buffer.from("Controlled private desktop input") });
    await page.getByText(en["s16.files.ready"], { exact: true }).waitFor();
    const input = f.service.files!.journal.all<FileUpload>().find(row => row.contract === "s16-file-upload/v1")!;
    f.script = [{ type: "tool_call", id: "offline_read", name: "file_read", arguments: { id: input.id, offset: 0 } }, { type: "tool_call", id: "offline_artifact", name: "file_create", arguments: { name: "desktop-note.txt", text: "Controlled private desktop result" } }];
    const composer = page.getByRole("textbox", { name: en["s16.chat.prompt"], exact: true });
    await composer.fill("Create a downloadable text file called desktop-note.txt");
    const admitted = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/messages") && response.request().method() === "POST");
    await composer.press("Enter"); expect((await admitted).status()).toBe(202); await f.service.conversation.drain();
    const preview = page.getByRole("button", { name: en["s16.artifact.preview"].replace("{name}", "desktop-note.txt"), exact: true });
    await preview.waitFor();
    await native.session.context.setOffline(true);
    await preview.waitFor({ state: "detached" });
    await page.locator(".desktop-panel > summary").click();
    await page.getByText(en["s16.desktop.offline"], { exact: true }).waitFor();
    expect(native.messages).toHaveLength(1); expect(native.decisions).toEqual([]);
    await native.session.context.setOffline(false);
    await page.getByRole("button", { name: en["s16.desktop.reconnect"], exact: true }).click();
    await preview.waitFor();
    expect(native.messages).toHaveLength(1); expect(f.vmCalls).toEqual([]);
  } finally { await native.close(); }
}, 60000);
