import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { createHash } from "node:crypto";
import { composedFixture } from "./fixtures/s15-composition";
import type { FileUpload } from "../src/s16/files/types";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-background-networking", "--no-first-run"] }); });
afterAll(async () => { await browser?.close(); });
browserTest.each([1440, 390])("actual file-memory source, impact, correction and forget UI at width %i", async width => {
  const f = await composedFixture("default", false, undefined, options => { options.proposedPolicy!.rules[0]!.adapters.push("s16_files"); options.proposedPolicy!.rules[0]!.operations.push("artifact_create"); return { ...options, files: { memory: true } }; });
  const value = "Working knowledge: The launch day is Friday.\n", sha256 = createHash("sha256").update(value).digest("hex");
  const pending = await (await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "upload", conversationId: "conversation", name: "knowledge.txt", bytes: Buffer.byteLength(value), sha256 })).json() as FileUpload;
  await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, value);
  f.script = [{ type: "tool_call", id: "read", name: "file_read", arguments: { id: pending.id, offset: 0 } }, { type: "tool_call", id: "create", name: "file_create", arguments: { name: "brief.md", text: "Launch day: Friday.\n" } }];
  await f.request("/api/s16/client/conversations/conversation/messages", "POST", { contract: "s16-conversation/v2", requestId: "work", conversationId: "conversation", text: "Create a downloadable brief from the file", continuation: null, files: [{ id: pending.id, sha256 }] }); await f.service.conversation.drain();
  expect(f.service.conversation.view(f.owner, "work").state).toBe("completed");
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: width === 1440 ? "en-US" : "th-TH" }), copy = width === 1440 ? en : th;
  const errors: string[] = [], external: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== "http://localhost:3099") { external.push(request.url()); await route.abort(); return; }
    const path = url.pathname + url.search, headers = { ...request.headers(), host: "localhost:3099" };
    const response = request.method() === "POST" ? request.headers()["content-type"]?.startsWith("application/x-www-form-urlencoded") ? await f.form(path, Object.fromEntries(new URLSearchParams(request.postData()!)), headers) : await f.request(path, "POST", request.postDataJSON(), headers) : await f.request(path, request.method(), undefined, headers);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto("http://localhost:3099/memory"); await page.getByText(value.trim(), { exact: true }).waitFor();
    await page.getByText(copy["s16.memory.fileSources"], { exact: true }).click(); expect(await page.locator(".s15-file-sources").innerText()).toContain(sha256);
    expect(await page.getByRole("link", { name: copy["s16.memory.sourceConversation"], exact: true }).getAttribute("href")).toBe("/s16/chat/conversation");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("link", { name: copy["s15.memory.forget"], exact: true }).click(); await page.locator(".s15-forget").waitFor();
    expect(await page.locator(".s15-forget .s-kv dd").nth(2).innerText()).toBe("2");
    await page.locator(".s15-forget").getByRole("link", { name: copy["s15.common.cancel"], exact: true }).click();
    await page.getByRole("link", { name: copy["s15.memory.correct"], exact: true }).click();
    const replacement = "Working knowledge: The launch day is Monday.";
    await page.getByRole("textbox", { name: copy["s15.memory.correct_label"], exact: true }).fill(replacement);
    await page.getByRole("button", { name: copy["s15.memory.save_correction"], exact: true }).click(); await page.getByText(replacement, { exact: true }).waitFor();
    expect(await page.getByText(value.trim(), { exact: true }).count()).toBe(0);
    await page.getByRole("link", { name: copy["s15.memory.forget"], exact: true }).click(); await page.locator(".s15-forget").getByRole("button", { name: copy["s15.memory.forget"], exact: true }).click();
    await page.getByText(copy["s15.memory.saved_forget"], { exact: true }).waitFor(); await page.reload();
    expect(await page.getByText(replacement, { exact: true }).count()).toBe(0); expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 30000);
