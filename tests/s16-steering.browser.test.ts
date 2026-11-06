import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { routineFixture } from "./fixtures/s16-routines";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

/** CHAT16-02 (#406) and NOTIFY16-01 (#441) in the real S16 bundle: steer running work, see its state, notification control. */
const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);

browserTest.each([1440, 390])("actual S16 steering of running work and notification control at width %i", async width => {
  const f = await routineFixture({ start: Date.now(), notifications: {} });
  const copy = width === 1440 ? en : th, locale = width === 1440 ? "en-US" : "th-TH";
  const gate = Promise.withResolvers<void>();
  f.replies.push({ tools: [{ name: "read", arguments: { path: "status.txt" } }], text: "Checked the computer.", gate: gate.promise });
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, timezoneId: "Asia/Bangkok" });
  const errors: string[] = [], external: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== "http://localhost:3099") { external.push(request.url()); await route.abort(); return; }
    const headers = { ...request.headers(), host: "localhost:3099" };
    const response = request.method() === "POST" ? await f.request(url.pathname + url.search, "POST", request.postDataJSON(), headers) : await f.request(url.pathname + url.search, request.method(), undefined, headers);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  let drain: Promise<void> | null = null;
  try {
    await page.goto("http://localhost:3099/s16/chat/steer_chat");
    const composer = page.getByRole("textbox", { name: copy["s16.chat.prompt"] }); await composer.waitFor();
    await composer.fill("Check the computer and summarize what changed.");
    await page.getByRole("button", { name: copy["s16.chat.send"], exact: true }).click();
    await composer.waitFor(); await page.waitForFunction(() => !(document.getElementById("message") as HTMLTextAreaElement | null)?.value);
    drain = f.service.conversation.drain();
    // While the run waits, the composer steers it and offers a separate conversation instead.
    await page.getByRole("button", { name: copy["s16.common.refresh"] }).click();
    await page.getByText(copy["s16.steer.hint"], { exact: false }).waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: copy["s16.steer.newChat"], exact: true }).waitFor();
    expect(await noOverflow()).toBe(true);
    await composer.fill("Also list the files you looked at.");
    await page.getByRole("button", { name: copy["s16.steer.send"], exact: true }).click();
    const steers = page.getByRole("list", { name: copy["s16.steer.label"] });
    await steers.getByText("Also list the files you looked at.", { exact: true }).waitFor();
    await steers.getByText(copy["s16.steer.sent"], { exact: true }).waitFor();
    gate.resolve(); await drain; drain = null;
    await page.getByRole("button", { name: copy["s16.common.refresh"] }).click();
    await steers.getByText(copy["s16.steer.applied"], { exact: true }).waitFor({ timeout: 15000 });
    expect(f.workInputs.some(input => input.includes("Also list the files you looked at."))).toBe(true);
    await page.getByRole("button", { name: copy["s16.chat.send"], exact: true }).waitFor();
    // Notifications: the owner-facing control is present with an honest device state.
    if (width === 390) await page.getByRole("button", { name: copy["s16.common.menu"] }).first().click();
    await page.getByText(`${copy["s16.notify.settings"]}:`, { exact: false }).waitFor();
    expect(await noOverflow()).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { gate.resolve(); await drain?.catch(() => {}); await context.close(); await f.close(); }
}, 60000);
