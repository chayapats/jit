import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import type { Model } from "schway/host";
import { composedFixture } from "./fixtures/s15-composition";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

// BOT16-01 + DELEG16-01 real React bundle: create a Bot through the reviewed proposal card, talk to it from a new chat,
// see delegated child cards, and archive with a keyboard-reachable confirmation, in English (desktop) and Thai (mobile).
const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);
const uid = () => crypto.randomUUID().replaceAll("-", "");

/** A parent with `delegate` hands one task to a temporary helper; everything else runs one VM command. */
const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
  const last = request.items.at(-1), reply = (content: ({ type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> } | { type: "text"; text: string })[]) => ({ type: "message_complete" as const, message: { type: "assistant" as const, id: uid(), content } });
  if (last?.type === "tool_result") { yield reply([{ type: "text", text: "Finished the work." }]); return; }
  if (request.tools?.some(tool => tool.name === "delegate") && JSON.stringify(request.items).includes("helpers")) { yield reply([{ type: "tool_call", id: uid(), name: "delegate", arguments: { assignments: [{ to: "temporary", task: "Tidy the notes folder." }] } }]); return; }
  yield reply([{ type: "tool_call", id: uid(), name: "bash", arguments: { command: "printf done" } }]);
} };

async function wire(page: Page, f: Awaited<ReturnType<typeof composedFixture>>, external: string[]) {
  await page.context().route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== "http://localhost:3099") { external.push(request.url()); await route.abort(); return; }
    const headers = { ...request.headers(), host: "localhost:3099" };
    const response = request.method() === "POST" ? await f.request(url.pathname + url.search, "POST", request.postDataJSON(), headers) : await f.request(url.pathname + url.search, request.method(), undefined, headers);
    if (request.method() === "POST" && /\/messages$/.test(url.pathname)) await f.service.conversation.drain();
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
}

browserTest.each([1440, 390])("actual S16 Bots: create from the card, chat, delegate and archive at width %i", async width => {
  const f = await composedFixture("default", false, undefined, o => ({ ...o, bots: {}, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, conversation: { ...o.conversation, limits: { ...o.conversation.limits, modelCalls: 12 } }, model: { ...o.model, scripted: () => model } }));
  const copy = width === 1440 ? en : th, locale = width === 1440 ? "en-US" : "th-TH", fill = (key: keyof typeof en, values: Record<string, string>) => Object.entries(values).reduce((text, [k, v]) => text.replace(`{${k}}`, v), copy[key]);
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, timezoneId: "Asia/Bangkok" });
  const errors: string[] = [], external: string[] = [];
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  await wire(page, f, external);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  try {
    await page.goto("http://localhost:3099/s16/bots/new");
    await page.getByRole("heading", { name: copy["s16.bots.new"], level: 1 }).waitFor();
    // An empty name is refused locally; no proposal is made.
    await page.getByRole("button", { name: copy["s16.bots.review"], exact: true }).click();
    await page.getByText(copy["s16.bots.nameRequired"], { exact: true }).waitFor();
    await page.getByLabel(copy["s16.bots.name"], { exact: true }).fill("Ledger");
    await page.getByLabel(copy["s16.bots.responsibility"], { exact: true }).fill("Keeps the household ledger tidy.");
    await page.getByRole("checkbox", { name: "repo" }).uncheck();
    await page.getByRole("button", { name: copy["s16.bots.review"], exact: true }).click();
    const card = page.getByRole("region", { name: fill("s16.bots.proposalTitle", { name: "Ledger" }) });
    await card.waitFor();
    await card.getByText("account, computer", { exact: true }).waitFor();
    expect(f.service.policy.owner.current(f.owner)!.bots.length).toBe(2);
    expect(await noOverflow()).toBe(true);
    await card.getByRole("button", { name: copy["s16.bots.accept"], exact: true }).click();
    await page.getByRole("heading", { name: "Ledger", level: 1 }).waitFor();
    const created = f.service.bots!.view(f.owner).bots.find(bot => bot.name === "Ledger")!;
    expect(created.excluded).toEqual(["repo"]);
    expect(f.service.policy.owner.current(f.owner)!.bots.map(b => b.id)).toContain(created.id);

    // Start a chat: the conversation is bound to Ledger on its first message and its replies carry Ledger's name.
    await page.getByRole("button", { name: copy["s16.bots.chat"], exact: true }).click();
    await page.getByRole("heading", { name: "Ledger", level: 1 }).waitFor();
    await page.getByLabel(copy["s16.chat.prompt"]).fill("Update the ledger notes");
    await page.getByRole("button", { name: copy["s16.chat.send"], exact: true }).click();
    await page.locator(".bot-message").getByText("Finished the work.").waitFor();
    await page.locator(".bot-message strong").filter({ hasText: "Ledger" }).first().waitFor();
    const conversationId = new URL(page.url()).pathname.split("/").at(-1)!;
    expect(f.service.bots!.conversationBot(conversationId)).toBe(created.id);

    // The main Bot hands a task to a temporary helper; the child card shows it and opens its own conversation.
    await page.goto("http://localhost:3099/s16");
    await page.getByLabel(copy["s16.chat.prompt"]).fill("Update this with helpers");
    await page.getByRole("button", { name: copy["s16.chat.send"], exact: true }).click();
    const children = page.getByRole("region", { name: copy["s16.bots.children"] });
    await children.waitFor();
    await children.getByText("Tidy the notes folder.", { exact: true }).waitFor();
    await children.getByText(copy["s16.bots.temporary"], { exact: true }).waitFor();
    expect(await noOverflow()).toBe(true);
    await children.getByRole("button", { name: copy["s16.bots.openChild"], exact: true }).click();
    await page.getByText(fill("s16.bots.assignmentFrom", { name: copy["s16.bots.mainName"] })).waitFor();

    // Archive: keyboard-reachable confirmation; Escape cancels without a command; confirming fences the chat.
    await page.goto(`http://localhost:3099/s16/bots/${created.id}`);
    const archive = page.getByRole("button", { name: copy["s16.bots.archive"], exact: true });
    await archive.focus(); await page.keyboard.press("Enter");
    const confirm = page.getByRole("group", { name: fill("s16.bots.archiveTitle", { name: "Ledger" }) }); await confirm.waitFor();
    await page.keyboard.press("Escape"); await confirm.waitFor({ state: "detached" });
    expect(f.service.bots!.profile(created.id)!.state).toBe("active");
    await archive.click(); await confirm.getByRole("button", { name: copy["s16.bots.archive"], exact: true }).click();
    await page.getByText(fill("s16.bots.archiveDone", { stopped: "0", paused: "0" })).waitFor();
    expect(f.service.bots!.profile(created.id)!.state).toBe("archived");
    await page.goto(`http://localhost:3099/s16/chat/${conversationId}`);
    await page.getByText(fill("s16.bots.archivedChat", { name: "Ledger" })).waitFor();
    expect(await page.getByLabel(copy["s16.chat.prompt"]).isDisabled()).toBe(true);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 90000);
