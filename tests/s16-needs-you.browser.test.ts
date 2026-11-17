import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Model } from "schway/host";
import { chromium, type Browser, type Page } from "playwright-core";
import type { BoxStream } from "../src/exec/box-runtime";
import type { VmScreenInput } from "../src/s15/vm/screen";
import { ComputerBrowser } from "../src/s16/computers/browser";
import { composedFixture } from "./fixtures/s15-composition";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); }, 20_000);
afterAll(async () => { await browser?.close(); }, 20_000);
const browserTest = test.skipIf(process.env.JIT_S16_BROWSER_TESTS !== "1");
const uid = () => crypto.randomUUID().replaceAll("-", "");

for (const width of [1440, 390]) browserTest(`actual needs-you card takes over, hands back and continues in ${width === 1440 ? "English" : "Thai"}`, async () => {
  const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await guest.route("https://notes.example.com/**", async route => route.fulfill({ status: 200, contentType: "text/html", body: (await route.request().allHeaders()).cookie?.includes("signed_in=1")
    ? '<!doctype html><h1>Signed-in fixture notes</h1><p>The working browser kept this session.</p>'
    : `<!doctype html><form><label>Fixture password<input type="password" autofocus></label><button>Sign in</button></form><script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();document.cookie='signed_in=1;Secure;SameSite=Strict;Path=/';location.reload()})</script>` }));
  const guestPage = await guest.newPage(); await guestPage.goto("https://notes.example.com/"); await guestPage.getByLabel("Fixture password").focus();
  const sent: VmScreenInput[] = [], commands: Record<string, unknown>[] = [], errors: string[] = [];
  const f = await composedFixture("default", false, undefined, o => ({ ...o, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, screen: {},
    model: { ...o.model, scripted: route => { const original = o.model.scripted!(route); return { ...original, async *stream(request, call) {
      if (!JSON.stringify(request.context).includes("screen-outcome-data-never-authority")) { yield* original.stream(request, call); return; }
      const content = request.items.some(item => item.type === "tool_result") ? [{ type: "text" as const, text: "Automatic continuation completed from observed evidence." }] : [{ type: "tool_call" as const, id: uid(), name: "bash", arguments: { command: "printf continued" } }];
      yield { type: "message_complete", message: { type: "assistant", id: uid(), content } };
    } } as Model; } },
    vm: { ...o.vm, managers: new Map([...o.vm.managers].map(([id, manager]) => [id, Object.assign(manager, { screen: () => ({ async unavailable() { return null; }, async capture() { return new Uint8Array(await guestPage.screenshot()); }, async send(input: VmScreenInput) { sent.push(input); if (input.kind === "text") await guestPage.keyboard.insertText(input.text); else if (input.kind === "key" && input.keys.join() === "ret") await guestPage.keyboard.press("Enter"); } }) })])) } }));
  let unauthenticated = false;
  const copy = width === 1440 ? en : th;
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: width === 1440 ? "en-US" : "th-TH" });
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== "http://localhost:3099") { await route.abort(); return; }
    const value = request.method() === "POST" ? request.postDataJSON() : undefined;
    if (url.pathname === "/api/s16/client/needs-you/commands") commands.push(value);
    const response = await f.request(url.pathname + url.search, request.method(), value, { ...request.headers(), host: "localhost:3099", ...(unauthenticated ? { cookie: "" } : {}) });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); const panel = page.locator(".computer-screen"); page.on("pageerror", error => errors.push(error.message));
  try {
    f.script = [{ type: "tool_call", id: uid(), name: "computer_browser", arguments: { kind: "needs_you", reason: "sign_in", origin: "https://notes.example.com" } }];
    expect((await f.chat("Open the notes.")).state).toBe("completed");
    await page.goto("http://localhost:3099/s16/chat/conversation");
    const card = page.locator('[id^="needs-you-"]');
    await card.getByText(copy["s16.needsYou.pending"], { exact: true }).waitFor();
    expect(await card.innerText()).toContain("https://notes.example.com");
    expect(await card.locator("input").count()).toBe(0);
    const watch = card.getByRole("button", { name: copy["s16.needsYou.watch"], exact: true });
    const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/s16/client/needs-you/commands", { timeout: 5000 });
    await watch.focus(); await watch.press("Enter");
    const decision = await response; expect(decision.status()).toBe(200);
    await panel.getByText(copy["s16.screen.state.owner"], { exact: true }).waitFor({ timeout: 5000 });
    expect(commands).toHaveLength(1); expect(commands[0]).toMatchObject({ kind: "watch", generation: 1 }); expect(sent).toEqual([]);
    const field = panel.getByLabel(copy["s16.screen.typeLabel"]); await field.fill("fixture-login");
    await page.waitForResponse(response => response.url().endsWith("/api/s16/client/conversations/conversation"), { timeout: 10_000 });
    expect(await field.inputValue()).toBe("fixture-login");
    await panel.getByRole("button", { name: copy["s16.screen.send"], exact: true }).click();
    await page.waitForFunction(() => (document.querySelector('.computer-screen input[type="password"]') as HTMLInputElement)?.value === "");
    expect(sent).toEqual([{ kind: "text", text: "fixture-login" }]);
    await panel.getByRole("button", { name: copy["s16.screen.key.ret"], exact: true }).click();
    await guestPage.getByRole("heading", { name: "Signed-in fixture notes", exact: true }).waitFor({ timeout: 5000 });
    await panel.getByRole("button", { name: copy["s16.screen.handBack"], exact: true }).click();
    await card.getByText(copy["s16.needsYou.resumed"], { exact: true }).waitFor();
    await panel.getByRole("button", { name: copy["s16.screen.close"], exact: true }).click();
    await card.getByText(copy["s16.continuation.completed"], { exact: true }).waitFor();
    await page.getByText(copy["s16.continuation.label"], { exact: true }).waitFor();
    expect(f.interpreterPrompts).toHaveLength(1);
    await page.waitForFunction(() => document.activeElement?.matches('[id^="needs-you-"] h3'));
    expect(f.service.screen!.cardOutcome(commands[0]!.cardId as string)).toMatchObject({ outcome: "resumed", generation: 3 });
    await guestPage.reload();
    const controller = new ComputerBrowser({ agentInput: vm => f.service.screen!.agentInput(vm), generation: vm => f.service.screen!.browserGeneration(vm), observedGeneration: (vm, generation) => f.service.screen!.observedBrowserGeneration(vm, generation), async unavailable() { return null; }, tier: host => host === "notes.example.com" ? "trusted" : undefined, stream: async () => nativeStream(guestPage) });
    try {
      const run = controller.open("vm", () => {}, new AbortController().signal);
      await expect(run.execute({ kind: "read", generation: 1 })).rejects.toMatchObject({ code: "computer_browser_stale" });
      const read = await run.execute({ kind: "read", generation: 3 });
      expect(read.text).toContain("Signed-in fixture notes"); expect(JSON.stringify(read)).not.toContain("fixture-login");
    } finally { controller.close(); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // A second card proves that session loss clears the independently held screen and private card text.
    f.script = [{ type: "tool_call", id: uid(), name: "computer_browser", arguments: { kind: "needs_you", reason: "verify", origin: "https://notes.example.com" } }];
    expect((await f.chat("Verify the notes.")).state).toBe("completed");
    await page.getByRole("button", { name: copy["s16.common.refresh"], exact: true }).first().click();
    const next = page.locator('[id^="needs-you-"]').last();
    await next.getByRole("button", { name: copy["s16.needsYou.watch"], exact: true }).click();
    await panel.getByText(copy["s16.screen.state.owner"], { exact: true }).waitFor();
    unauthenticated = true; await panel.waitFor({ state: "detached", timeout: 10_000 });
    await page.getByText(copy["s16.common.authenticationRequired"], { exact: true }).waitFor();
    expect(await page.locator("body").innerText()).not.toContain("https://notes.example.com");
    expect((await f.service.screen!.view(f.owner, "vm")).state).toBe("owner");
    f.advance(31_000); expect((await f.service.screen!.view(f.owner, "vm")).state).toBe("fenced");
    expect(errors).toEqual([]);
  } finally { await context.close(); await f.close(); await guest.close(); }
}, 30_000);

/** Fixture transport only: executes the production observation in a real Chromium page; no guest/SSH proof. */
function nativeStream(page: Page): BoxStream {
  let output!: ReadableStreamDefaultController<Uint8Array>, closed = false;
  const exit = Promise.withResolvers<number>();
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  return { stdout, exited: exit.promise, settled: Promise.resolve(), close() { if (!closed) { closed = true; output.close(); exit.resolve(0); } }, write(bytes) {
    const message = JSON.parse(Buffer.from(bytes).subarray(0, -1).toString());
    void (async () => {
      let result: Record<string, unknown> = {};
      const tab = { targetId: "notes", type: "page", url: page.url(), title: "Notes" };
      if (message.method === "Target.getTargets") result = { targetInfos: [tab] };
      else if (message.method === "Target.getTargetInfo") result = { targetInfo: tab };
      else if (message.method === "Target.attachToTarget") result = { sessionId: "notes_session" };
      else if (message.method === "Runtime.evaluate") result = { result: { value: await page.evaluate(message.params.expression) } };
      if (!closed) output.enqueue(Buffer.from(JSON.stringify({ id: message.id, result }) + "\0"));
    })().catch(error => { if (!closed) output.enqueue(Buffer.from(JSON.stringify({ id: message.id, error: { code: -1, message: String(error) } }) + "\0")); });
  } };
}
