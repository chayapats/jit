import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import type { FileUpload } from "../src/s16/files/types";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-background-networking", "--no-first-run"] }); });
afterAll(async () => { await browser?.close(); });

browserTest.each([1440, 390])("real React upload, committed artifact preview/download, withdrawal and keyboard at width %i", async width => {
  const f = await composedFixture("default", false, undefined, options => { options.proposedPolicy!.rules[0]!.adapters.push("s16_files"); options.proposedPolicy!.rules[0]!.operations.push("artifact_create"); return { ...options, files: {} }; });
  const text = width === 1440 ? en : th;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, acceptDownloads: true, locale: width === 1440 ? "en-US" : "th-TH" });
  const external: string[] = [], errors: string[] = [];
  let loseReply = width === 390, messages = 0;
  let holdSnapshot = false, expired = false;
  const snapshotEntered = Promise.withResolvers<void>(), releaseSnapshot = Promise.withResolvers<void>(), snapshotSettled = Promise.withResolvers<void>();
  context.setDefaultTimeout(10000);
  await context.route("**/*", async route => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.origin !== "http://localhost:3099") { external.push(incoming.url()); await route.abort(); return; }
    const headers = { ...incoming.headers(), host: "localhost:3099", ...(expired ? { cookie: "" } : {}) }, path = url.pathname + url.search;
    const response = incoming.method() === "POST" ? incoming.headers()["content-type"] === "application/octet-stream" ? await f.raw(path, new Uint8Array(incoming.postDataBuffer()!).buffer, headers) : await f.request(path, "POST", incoming.postDataJSON(), headers) : await f.request(path, incoming.method(), undefined, headers);
    if (incoming.method() === "POST" && path.endsWith("/messages")) { messages++; if (loseReply) { loseReply = false; await route.abort("failed"); return; } }
    if (holdSnapshot && path === "/api/s16/client/conversations/conversation") { holdSnapshot = false; snapshotEntered.resolve(); await releaseSnapshot.promise; try { await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) }); } catch { /* The privacy fence may already have aborted this request. */ } finally { snapshotSettled.resolve(); } return; }
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("http://localhost:3099/s16/chat/conversation");
    await page.waitForFunction(() => document.querySelector<HTMLButtonElement>(".composer-actions button")?.disabled === false);
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Launch: Friday.\n<script>window.attacked=true</script>\n") });
    await page.getByText(text["s16.files.ready"], { exact: true }).waitFor();
    const input = f.service.files!.journal.all<FileUpload>().find(row => row.contract === "s16-file-upload/v1")!;
    f.script = [{ type: "tool_call", id: "read", name: "file_read", arguments: { id: input.id, offset: 0 } }, { type: "tool_call", id: "write", name: "file_create", arguments: { name: "brief.md", text: "# Brief\nLaunch: Friday.\n<script>window.attacked=true</script>\n" } }];
    await page.getByRole("textbox", { name: text["s16.chat.prompt"], exact: true }).fill(width === 390 ? "สรุปโน้ตเหล่านี้แล้วสร้างไฟล์ Markdown ให้ดาวน์โหลด" : "Create a downloadable Markdown brief from the attached notes");
    await page.getByRole("textbox", { name: text["s16.chat.prompt"], exact: true }).press("Enter");
    if (width === 390) await page.getByRole("button", { name: text["s16.chat.recover"], exact: true }).click();
    const preview = text["s16.artifact.preview"].replace("{name}", "brief.md"), downloadLabel = text["s16.artifact.download"].replace("{name}", "brief.md");
    await page.getByRole("button", { name: preview, exact: true }).waitFor();
    const downloadEvent = page.waitForEvent("download"); await page.getByRole("button", { name: downloadLabel, exact: true }).click();
    const download = await downloadEvent; expect(download.suggestedFilename()).toBe("brief.md");
    await page.getByRole("button", { name: preview, exact: true }).click();
    await page.locator(".preview-text").waitFor(); expect(await page.locator(".preview-text").textContent()).toContain("<script>window.attacked=true</script>");
    expect(await page.evaluate(() => Reflect.get(window, "attacked"))).toBeUndefined();
    await page.keyboard.press("Escape"); expect(await page.getByRole("button", { name: preview, exact: true }).evaluate(button => button === document.activeElement)).toBe(true);
    await page.reload(); await page.getByRole("button", { name: preview, exact: true }).waitFor();
    if (width === 390) {
      holdSnapshot = true; await page.getByRole("button", { name: text["s16.common.refresh"], exact: true }).click(); await snapshotEntered.promise;
      expired = true; await page.getByRole("button", { name: text["s16.common.refresh"], exact: true }).click(); await page.getByText(text["s16.common.error"], { exact: true }).waitFor();
      releaseSnapshot.resolve(); await snapshotSettled.promise; await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.getByRole("button", { name: preview, exact: true }).count()).toBe(0);
      expired = false; await page.getByRole("button", { name: text["s16.common.refresh"], exact: true }).click(); await page.getByRole("button", { name: preview, exact: true }).waitFor();
    }
    await page.getByRole("button", { name: text["s16.files.withdraw"], exact: true }).click();
    await page.getByRole("button", { name: preview, exact: true }).waitFor({ state: "detached" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]); expect(f.vmCalls).toEqual([]); expect(messages).toBe(1);
  } finally { releaseSnapshot.resolve(); await context.close(); await f.close(); }
}, 30000);

browserTest("non-local HTTP without WebCrypto gives a specific explanation before creating client requests", async () => {
  const f = await composedFixture(), context = await browser.newContext({ locale: "en-US" });
  const requested: string[] = [], errors: string[] = [];
  await context.route("**/*", async route => {
    const incoming = route.request(), url = new URL(incoming.url());
    if (url.origin !== "http://jit.test") { await route.abort(); return; }
    requested.push(url.pathname);
    const response = await f.request(url.pathname, incoming.method(), undefined, { ...incoming.headers(), host: "localhost:3099" });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("http://jit.test/s16"); await page.getByText(en["s16.common.secureContext"], { exact: true }).waitFor();
    expect(await page.locator(".s16-app").count()).toBe(0); expect(requested.some(path => path.startsWith("/api/"))).toBe(false); expect(errors).toEqual([]); expect(f.vmCalls).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 30000);
