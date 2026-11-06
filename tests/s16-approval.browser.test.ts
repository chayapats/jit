import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import { mail } from "./fixtures/s15-effects";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

/** AUTH16-01 (#442) in the real S16 bundle: a held send is an inline card that one press approves exactly once. */
const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);

browserTest.each([1440, 390])("actual in-chat approval card at width %i", async width => {
  const f = await composedFixture();
  const copy = width === 1440 ? en : th, locale = width === 1440 ? "en-US" : "th-TH";
  f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["account"], access: "effect", subject: null };
  f.script = [{ type: "tool_call", id: "email", name: "gmail_prepare_send", arguments: { ...mail(), subject: "Quarterly status", body: "Line one\nLine two with a very-long-unbroken-token-" + "x".repeat(120) } }];
  const held = await f.chat("Send the prepared email to the recipient");
  expect(held.slips[0]?.state).toBe("pending"); expect(f.google.sent.size).toBe(0);
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, timezoneId: "Asia/Bangkok" });
  const errors: string[] = [], external: string[] = [], decisions: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== "http://localhost:3099") { external.push(request.url()); await route.abort(); return; }
    const headers = { ...request.headers(), host: "localhost:3099" };
    if (url.pathname.endsWith("/decisions")) decisions.push((request.postDataJSON() as { requestId: string }).requestId);
    const response = request.method() === "POST" ? await f.request(url.pathname + url.search, "POST", request.postDataJSON(), headers) : await f.request(url.pathname + url.search, request.method(), undefined, headers);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("http://localhost:3099/s16/chat/conversation");
    const card = page.getByRole("region", { name: copy["s16.card.title.email"] });
    await card.waitFor({ timeout: 15000 });
    expect(await card.getByText("recipient@example.test").count()).toBeGreaterThan(0);
    expect(await card.getByText("Quarterly status", { exact: true }).count()).toBe(1);
    expect(await card.getByText(copy["s16.card.once"], { exact: false }).count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (process.env.JIT_S16_SCREENSHOT_DIR) await card.screenshot({ path: `${process.env.JIT_S16_SCREENSHOT_DIR}/approval-card-${width}.png` });
    // Keyboard reaches Approve; one press decides once and the effect runs once.
    const approve = card.getByRole("button", { name: copy["s16.card.approve"], exact: true });
    await approve.focus(); await page.keyboard.press("Enter");
    await card.waitFor({ state: "detached", timeout: 15000 });
    await f.service.conversation.drain();
    expect(f.google.sent.size).toBe(1); expect(decisions).toHaveLength(1);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 60000);
