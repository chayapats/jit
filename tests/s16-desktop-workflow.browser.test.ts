import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { desktopSessionFixture } from "./fixtures/s16-desktop-session";
import type { FileUpload } from "../src/s16/files/types";
import { mail } from "./fixtures/s15-effects";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_DESKTOP_TESTS === "1" ? test : test.skip;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
browserTest.each(["en", "th"] as const)("native %s file/result download and lost admission receipt survive complete client reconnect", async locale => {
  const native = await desktopSessionFixture(locale), { f } = native, copy = locale === "en" ? en : th;
  let page = native.app;
  try {
    await page.setViewportSize({ width: locale === "en" ? 1440 : 390, height: 900 });
    await page.goto(native.origin + "/s16/chat/conversation");
    const notes = "Launch: Friday.\n<script>window.attacked=true</script>\n", result = "# Brief\nLaunch: Friday.\n<script>window.attacked=true</script>\n";
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from(notes) });
    await page.getByText(copy["s16.files.ready"], { exact: true }).waitFor();
    const input = f.service.files!.journal.all<FileUpload>().find(row => row.contract === "s16-file-upload/v1")!;
    expect(input.receipt?.sha256).toBe(sha(notes));
    f.script = [{ type: "tool_call", id: "desktop_read", name: "file_read", arguments: { id: input.id, offset: 0 } }, { type: "tool_call", id: "desktop_create", name: "file_create", arguments: { name: "brief.md", text: result } }];
    let lost = false;
    await native.session.context.route(native.origin + "/api/s16/client/conversations/conversation/messages", async route => {
      if (lost || route.request().method() !== "POST") { await route.fallback(); return; }
      lost = true;
      // The actual owning HTTP service has admitted this command. Lose only its browser reply; never manufacture a
      // receipt or call the fixture's authenticated helper in place of the native client's real cookie/CSRF request.
      const admitted = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      try { expect(admitted.status()).toBe(202); await route.abort("failed"); }
      finally { await admitted.dispose(); }
    });
    const composer = page.getByRole("textbox", { name: copy["s16.chat.prompt"], exact: true });
    await composer.fill("Create a downloadable Markdown brief from the attached file"); await composer.press("Enter");
    await page.getByText(copy["s16.chat.unknown"], { exact: true }).waitFor();
    const original = new URL(page.url()).hash; expect(original).toMatch(/^#[A-Za-z0-9_-]+$/);
    await f.service.conversation.drain();
    await page.reload();
    const preview = copy["s16.artifact.preview"].replace("{name}", "brief.md");
    await page.getByRole("button", { name: preview, exact: true }).waitFor();
    expect(native.messages).toEqual([original.slice(1)]); expect(new URL(page.url()).hash).toBe("");
    await page.getByRole("button", { name: preview, exact: true }).click();
    await page.locator(".preview-text").waitFor(); expect(await page.locator(".preview-text").textContent()).toBe(result);
    expect(await page.evaluate(() => Reflect.get(window, "attacked"))).toBeUndefined();
    await page.keyboard.press("Escape"); expect(await page.getByRole("button", { name: preview, exact: true }).evaluate(button => button === document.activeElement)).toBe(true);
    const completed = new Promise<void>((resolve, reject) => {
      native.session.cdp.on("Browser.downloadProgress", event => { if (event.state === "completed") resolve(); if (event.state === "canceled") reject(new Error("fixture_download_canceled")); });
    });
    await page.getByRole("button", { name: copy["s16.artifact.download"].replace("{name}", "brief.md"), exact: true }).click();
    await completed;
    const bytes = readFileSync(join(native.downloads, "brief.md")); expect(bytes.toString()).toBe(result); expect(sha(bytes)).toBe(sha(result));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    page = await native.reopen(); await page.goto(native.origin + "/s16/chat/conversation");
    await page.getByRole("button", { name: preview, exact: true }).waitFor(); expect(native.messages).toHaveLength(1);
    const cached = await page.evaluate(async () => Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => request.url))));
    expect(cached.flat().every(url => !/\/api\/|\/artifacts\/|\/uploads\//.test(url))).toBe(true);
    expect(f.vmCalls).toEqual([]);
  } finally { await native.close(); }
}, 60000);

browserTest.each(["en", "th"] as const)("native %s exact approval and existing Bots/computer views create no host enrollment", async locale => {
  const native = await desktopSessionFixture(locale, true), { f, app: page } = native, copy = locale === "en" ? en : th;
  try {
    await page.setViewportSize({ width: locale === "en" ? 1440 : 390, height: 900 });
    await page.goto(native.origin + "/s16/chat/conversation");
    f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["account"], access: "effect", subject: null };
    f.script = [{ type: "tool_call", id: "desktop_email", name: "gmail_prepare_send", arguments: { ...mail(), subject: "Desktop exact approval" } }];
    const composer = page.getByRole("textbox", { name: copy["s16.chat.prompt"], exact: true });
    await composer.fill("Send the prepared email to recipient@example.test"); await composer.press("Enter");
    await f.service.conversation.drain();
    const card = page.getByRole("region", { name: copy["s16.card.title.email"] }); await card.waitFor();
    expect(f.google.sent.size).toBe(0); expect(native.decisions).toEqual([]);
    await card.getByText("Desktop exact approval", { exact: true }).waitFor();
    await card.getByRole("button", { name: copy["s16.card.approve"], exact: true }).focus(); await page.keyboard.press("Enter");
    await card.waitFor({ state: "detached" }); await f.service.conversation.drain();
    expect(f.google.sent.size).toBe(1); expect(native.decisions).toHaveLength(1);
    await page.reload(); expect(f.google.sent.size).toBe(1); expect(native.decisions).toHaveLength(1);
    await page.goto(native.origin + "/s16/bots"); await page.getByRole("heading", { name: copy["s16.bots.title"], exact: true, level: 1 }).waitFor();
    await page.goto(native.origin + "/s16/computers"); await page.getByRole("heading", { name: copy["s16.computers.title"], exact: true, level: 1 }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(f.vmCalls).toEqual([]); expect(native.decisions).toHaveLength(1);
    const bootstrap = await (await native.session.context.request.get(native.origin + "/api/s16/client/bootstrap", { maxRedirects: 0 })).json();
    expect(bootstrap.capabilities.computers.available).toBe(true); expect(bootstrap.capabilities.bots.available).toBe(true);
  } finally { await native.close(); }
}, 60000);
