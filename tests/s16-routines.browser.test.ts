import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { routineFixture } from "./fixtures/s16-routines";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);

browserTest.each([1440, 390])("actual S16 routine schedule-from-chat, review, save, run now, reaction and history at width %i", async width => {
  const f = await routineFixture({ start: Date.now() });
  const copy = width === 1440 ? en : th, locale = width === 1440 ? "en-US" : "th-TH";
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
  try {
    await page.goto("http://localhost:3099/s16/chat/routine_chat");
    const composer = page.getByRole("textbox", { name: copy["s16.chat.prompt"] }); await composer.waitFor();
    await composer.fill("Check the computer every weekday at 9:30 and summarize what changed.");
    await page.getByRole("button", { name: copy["s16.chat.schedule"], exact: true }).click();
    // Conversational entry opens a review sheet; nothing is saved yet.
    const sheet = page.getByRole("dialog", { name: copy["s16.routine.sheet.title"] }); await sheet.waitFor();
    expect(await sheet.getByLabel(copy["s16.routine.field.repeat"], { exact: true }).inputValue()).toBe("weekdays");
    expect(await sheet.getByLabel(copy["s16.routine.field.time"], { exact: true }).inputValue()).toBe("09:30");
    expect(await sheet.getByLabel(copy["s16.routine.field.timezone"], { exact: true }).inputValue()).toBe("Asia/Bangkok");
    expect(f.service.routines!.list(f.owner).routines).toEqual([]); expect(await noOverflow()).toBe(true);
    await sheet.getByLabel(copy["s16.routine.field.name"], { exact: true }).fill("Weekday check");
    await sheet.getByRole("button", { name: copy["s16.routine.sheet.review"], exact: true }).click();
    const review = page.getByRole("dialog", { name: copy["s16.routine.sheet.reviewTitle"] }); await review.waitFor();
    expect(await review.locator("ol li").count()).toBe(3); expect(await review.locator("ol li").first().textContent()).toContain("09:30 (Asia/Bangkok)");
    await review.getByText(copy["s16.routine.approvals"], { exact: true }).waitFor();
    expect(f.service.routines!.list(f.owner).routines).toEqual([]);
    await review.getByRole("button", { name: copy["s16.routine.sheet.save"], exact: true }).click();
    // The saved routine opens with its real state and next runs.
    await page.getByRole("heading", { name: "Weekday check", exact: true }).waitFor();
    const saved = f.service.routines!.list(f.owner).routines;
    expect(saved).toHaveLength(1); expect(saved[0]!.routine.draft).toMatchObject({ conversationId: "routine_chat", schedule: { kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:30" }, timezone: "Asia/Bangkok", quiet: true });
    await page.waitForURL(`http://localhost:3099/s16/routines/${saved[0]!.routine.id}`, { timeout: 3000 });
    const detail = page.locator(".routine-detail");
    await detail.getByText(copy["s16.routine.state.active"], { exact: true }).first().waitFor();
    await detail.getByRole("button", { name: copy["s16.routine.runNow"], exact: true }).click();
    await f.service.drain(); await f.service.conversation.drain(); await f.service.drain();
    await detail.locator(".routine-history").getByText(copy["s16.routine.run.succeeded"], { exact: true }).waitFor({ timeout: 15000 });
    expect(await noOverflow()).toBe(true);
    // A signed reaction shows its secret once, inside this response only.
    await detail.getByLabel(copy["s16.routine.source.kind"]).selectOption("signed");
    await detail.getByLabel(copy["s16.routine.source.names"]).fill("inbox.updated");
    await detail.getByRole("button", { name: copy["s16.routine.source.add"], exact: true }).click();
    await detail.getByText(copy["s16.routine.source.copyOnce"], { exact: true }).waitFor();
    const secret = await detail.locator(".routine-secret code").nth(1).textContent();
    expect(secret).toMatch(/^jitrt_/); expect(await noOverflow()).toBe(true);
    await page.reload(); await page.getByRole("heading", { name: "Weekday check", exact: true }).waitFor();
    expect(await page.content()).not.toContain(secret!);
    // The run appears in the conversation labelled as a routine run, not as a live owner message.
    await page.locator(".routine-detail").getByRole("button", { name: copy["s16.routine.openConversation"], exact: true }).click();
    await page.getByText(copy["s16.chat.routineRun"], { exact: true }).first().waitFor();
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 60000);
