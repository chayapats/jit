import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import type { Model } from "schway/host";
import { composedFixture } from "./fixtures/s15-composition";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-background-networking", "--no-first-run"] }); });
afterAll(async () => { await browser?.close(); });

browserTest.each([1440, 390])("actual S16 memory search, inspect, correct, forget and source navigation at width %i", async width => {
  const inputs: string[] = [];
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) { inputs.push(JSON.stringify(request)); yield { type: "message_complete", message: { type: "assistant", id: "m" + inputs.length, content: [{ type: "text", text: "Noted." }] } }; } };
  const f = await composedFixture("default", false, undefined, options => ({ ...options, model: { ...options.model, scripted: () => model } }));
  f.interpretation = { intent: "answer", purposeId: "purpose", resourceIds: ["computer"], access: "read", subject: null };
  for (const [id, text] of [["pref", "I prefer concise replies."], ["zone", "My timezone is Asia/Bangkok."]] as const) {
    expect((await f.request(`/api/s16/client/conversations/${id}/messages`, "POST", { contract: "s15-conversation/v1", requestId: id, conversationId: id, text, continuation: null })).status).toBe(202); await f.service.conversation.drain();
  }
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: width === 1440 ? "en-US" : "th-TH" }), copy = width === 1440 ? en : th;
  const fill = (key: keyof typeof en, values: Record<string, string | number>) => copy[key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
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
    await page.goto("http://localhost:3099/s16/memory");
    await page.getByRole("heading", { name: copy["s16.memory.title"], exact: true }).waitFor();
    const results = page.locator(".memory-list");
    await results.getByText("I prefer concise replies.", { exact: true }).waitFor(); await results.getByText("My timezone is Asia/Bangkok.", { exact: true }).waitFor();
    expect(await noOverflow()).toBe(true);

    await page.getByRole("searchbox", { name: copy["s16.memory.search"] }).fill("concise");
    await page.getByText(fill("s16.memory.count", { from: 1, to: 1, total: 1 }), { exact: true }).waitFor();
    expect(await results.getByText("My timezone is Asia/Bangkok.", { exact: true }).count()).toBe(0);

    // Keyboard: open, Escape closes the inspector first and returns focus to the row.
    const row = page.getByRole("button", { name: fill("s16.memory.open", { text: "I prefer concise replies." }), exact: true });
    await row.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: copy["s16.memory.detail"] }); await dialog.waitFor();
    await dialog.locator(".memory-text").getByText("I prefer concise replies.", { exact: true }).waitFor();
    expect(await dialog.getByText(`${copy["s16.memory.kindFact"]} · ${copy["s16.memory.confirmationOwner"]}`, { exact: true }).count()).toBe(1);
    expect(await noOverflow()).toBe(true);
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    expect(await row.evaluate(element => element === document.activeElement)).toBe(true);

    // Correct: a superseding owner-stated fact; the old item becomes a labelled, erased chain entry.
    await row.click(); await dialog.waitFor();
    await dialog.getByRole("button", { name: copy["s16.memory.correct"], exact: true }).click();
    await dialog.getByRole("textbox", { name: copy["s16.memory.correctLabel"], exact: true }).fill("I prefer detailed replies.");
    await dialog.getByRole("button", { name: copy["s16.memory.saveCorrection"], exact: true }).click();
    await dialog.getByText(copy["s16.memory.corrected"], { exact: true }).waitFor();
    await dialog.locator(".memory-text").getByText("I prefer detailed replies.", { exact: true }).waitFor();
    await dialog.getByRole("heading", { name: copy["s16.memory.chain"], exact: true }).waitFor();
    expect(await dialog.locator(".memory-chain").getByText(copy["s16.memory.stateSuperseded"], { exact: true }).count()).toBe(1);
    const claims = f.service.memory.view(f.owner).claims;
    expect(claims.find(claim => claim.supersedes)).toMatchObject({ text: "I prefer detailed replies.", confirmation: "owner_stated", lifecycle: "active" });

    // Forget: impact preview first, then explicit confirmation.
    await dialog.getByRole("button", { name: copy["s16.memory.forget"], exact: true }).click();
    await dialog.getByRole("heading", { name: copy["s16.memory.forgetTitle"], exact: true }).waitFor();
    await dialog.getByText(copy["s16.memory.forgetLimits"], { exact: true }).waitFor();
    const impactPattern = new RegExp("^" + copy["s16.memory.forgetImpact"].replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(claims|sources)\}/g, "1").replace(/\{\w+\}/g, "\\d+") + "$");
    await dialog.locator(".memory-forget").getByText(impactPattern).waitFor();
    await dialog.getByRole("button", { name: copy["s16.memory.forgetConfirm"], exact: true }).click();
    await dialog.getByText(copy["s16.memory.forgotten"], { exact: true }).waitFor();
    await dialog.locator(".memory-labels").getByText(copy["s16.memory.stateForgotten"], { exact: true }).first().waitFor();
    expect(f.service.memory.view(f.owner).claims.filter(claim => claim.lifecycle === "active").map(claim => claim.text)).toEqual(["My timezone is Asia/Bangkok."]);
    await dialog.getByRole("button", { name: copy["s16.common.close"], exact: true }).click();

    await page.getByRole("searchbox", { name: copy["s16.memory.search"] }).fill("");
    await page.getByLabel(copy["s16.memory.filterState"]).selectOption("inactive");
    await page.getByText(fill("s16.memory.count", { from: 1, to: 2, total: 2 }), { exact: true }).waitFor();
    expect(await page.locator(".memory-list .memory-erased").count()).toBe(2);
    expect(await page.locator(".memory-list").innerText()).not.toContain("replies");

    // Source navigation opens the original conversation, which remains available.
    await page.getByLabel(copy["s16.memory.filterState"]).selectOption("active");
    await page.getByRole("button", { name: fill("s16.memory.open", { text: "My timezone is Asia/Bangkok." }), exact: true }).click();
    await dialog.getByRole("button", { name: copy["s16.memory.sourceConversation"], exact: true }).click();
    await page.waitForURL("http://localhost:3099/s16/chat/zone");
    await page.locator(".owner-message").getByText("My timezone is Asia/Bangkok.", { exact: true }).waitFor();
    expect(await noOverflow()).toBe(true); expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 60000);
