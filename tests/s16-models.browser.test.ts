import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); });
const browserTest = test.skipIf(process.env.JIT_S16_BROWSER_TESTS !== "1");

for (const width of [1440, 390]) browserTest(`actual model controls preserve unavailable pins and render honest usage at width ${width}`, async () => {
  const f = await composedFixture("default", false, undefined, o => ({ ...o, bots: {} }));
  const copy = width === 1440 ? en : th, errors: string[] = [], external: string[] = [], updates: unknown[] = [];
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: width === 1440 ? "en-US" : "th-TH" });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://localhost:3099") { external.push(request.url()); await route.abort(); return; }
    const value = request.method() === "POST" ? request.postDataJSON() : undefined;
    if (url.pathname === "/api/s16/client/bots/commands") updates.push(value);
    const response = await f.request(url.pathname + url.search, request.method(), value, { ...request.headers(), host: "localhost:3099" });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    const response = await f.request("/api/s16/client/bots/commands", "POST", { contract: "s16-bot-command/v1", requestId: "pin", kind: "bot.update", botId: "bot", expectedRevision: 0, name: "Jit", responsibility: "Keep context", selection: f.choice, assignments: true });
    expect(response.status).toBe(200);
    // A persisted formerly approved model can disappear from the current registry/policy.
    f.service.bots!.store.db.query("UPDATE bots SET record_json=json_set(record_json,'$.selection.model.id','missing') WHERE id='bot'").run();
    await page.goto("http://localhost:3099/s16/bots/bot");
    await page.getByLabel(copy["s16.bots.model"], { exact: true }).waitFor();
    expect(await page.getByLabel(copy["s16.bots.model"], { exact: true }).inputValue()).not.toBe("default");
    await page.getByLabel(copy["s16.bots.name"], { exact: true }).fill("Renamed Jit");
    await page.getByRole("button", { name: copy["s16.bots.save"], exact: true }).click();
    await page.locator(".bot-form [role=alert]").waitFor(); expect(updates).toHaveLength(0);
    await page.getByLabel(copy["s16.bots.model"], { exact: true }).selectOption("default");
    await page.getByRole("button", { name: copy["s16.bots.save"], exact: true }).click();
    await page.getByText(copy["s16.bots.saved"], { exact: true }).waitFor();
    expect(updates).toHaveLength(1); expect(f.service.bots!.profile("bot")!.selection).toBeNull();
    await page.locator(".model-settings > summary").focus(); await page.locator(".model-settings > summary").press("Enter");
    await page.getByRole("link", { name: copy["s16.models.signIn"] }).waitFor();
    expect(await page.locator(".model-settings").innerText()).toContain(copy["s16.models.account"]);
    expect(await page.locator(".model-settings").innerText()).toContain("provider_account");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    const row = await f.chat("Update the notes using the explicit default."); expect(row.state).toBe("completed");
    await page.goto("http://localhost:3099/s16/chat/conversation");
    await page.locator(".model-usage > summary").waitFor(); await page.locator(".model-usage > summary").click();
    const usage = await page.locator(".model-usage").innerText();
    expect(usage).toContain("fixture-model"); expect(usage).toContain(copy["s16.models.unknown"]);
    expect(usage).toContain(copy["s16.models.inputTokens"]); expect(usage).toContain(copy["s16.models.effortHint"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
});
