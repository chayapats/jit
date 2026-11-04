import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { actionsFixture, conversationId } from "./fixtures/s15-web-actions";
import { newId, origin, webFixture } from "./fixtures/s15-web";
import { th } from "../src/i18n/th";

// Opt-in real-browser checks over the production handler. All HTTP is intercepted in process; no server,
// provider, account, external website, credential store or installed host is contacted.
const browserTest = process.env.JIT_S15_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => {
  if (process.env.JIT_S15_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--disable-background-networking", "--no-first-run"] });
});
afterAll(async () => { await browser?.close(); });
type Handler = (request: Request) => Promise<Response> | Response;
async function surface(handler: Handler, afterPost: () => Promise<void>, options: { mobile?: boolean; script?: boolean; motion?: boolean } = {}) {
  const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, javaScriptEnabled: options.script !== false, reducedMotion: options.motion === false ? "reduce" : "no-preference" });
  context.setDefaultTimeout(6000); context.setDefaultNavigationTimeout(6000);
  await context.addCookies([{ name: "jit_s15", value: "owner-token", url: origin }]);
  const mutations: string[] = [], external: string[] = [], errors: string[] = [];
  await context.route("**/*", async route => {
    const incoming = route.request();
    if (new URL(incoming.url()).origin !== origin) { external.push(incoming.url()); await route.abort(); return; }
    if (incoming.method() !== "GET") mutations.push(new URL(incoming.url()).pathname);
    const response = await handler(new Request(incoming.url(), { method: incoming.method(), headers: { ...incoming.headers(), host: "jit.test" }, ...(incoming.postDataBuffer() ? { body: new Uint8Array(incoming.postDataBuffer()!) } : {}) }));
    if (incoming.method() === "POST") await afterPost();
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  return { context, page, mutations, external, errors };
}
async function ready(page: Page) { await page.waitForFunction(() => document.documentElement.dataset.s15Enhanced === "true"); }
async function go(page: Page, selector: string, path: string) { await page.locator(selector).first().click(); await page.waitForURL(url => url.pathname === path); await page.waitForFunction(() => !document.querySelector(".s15-dialog[open]")); }
async function clean(context: BrowserContext) { await context.close(); }
async function snapshot(page: Page, name: string) {
  const directory = process.env.JIT_S15_SCREENSHOTS;
  if (directory) {
    mkdirSync(directory, { recursive: true });
    await page.evaluate(async () => { await document.fonts.ready; await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)); });
    await page.screenshot({ path: join(directory, `${name}.png`) });
  }
}

browserTest("premium navigation preserves text/caret, resolves new-chat redirects, quotes data and opens fresh evidence", async () => {
  const fixture = webFixture(), conversation = newId();
  await fixture.send(conversation, "Create hello.txt containing hello."); await fixture.app.drain();
  const ui = await surface(fixture.handler, () => fixture.app.drain());
  try {
    await ui.page.goto(`${origin}/chats/${conversation}`); await ready(ui.page);
    await snapshot(ui.page, "desktop-conversation");
    await ui.page.evaluate(() => Object.defineProperty(window, "s15DocumentMarker", { value: "same-document" }));
    await ui.page.locator("#s15-text").fill("Keep this draft for later");
    await ui.page.locator("#s15-text").evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(5, 9));
    await go(ui.page, '.s-nav a[href="/memory"]', "/memory");
    await go(ui.page, `.s-nav a[href="/chats/${conversation}#latest"]`, `/chats/${conversation}`);
    expect(await ui.page.locator("#s15-text").inputValue()).toBe("Keep this draft for later");
    expect(await ui.page.locator("#s15-text").evaluate((area: HTMLTextAreaElement) => [area.selectionStart, area.selectionEnd])).toEqual([5, 9]);
    expect(await ui.page.evaluate(() => Reflect.get(window, "s15DocumentMarker"))).toBe("same-document");
    await ui.page.locator("[data-s15-quote]").first().click();
    expect(await ui.page.locator("#s15-text").inputValue()).toContain("> Finished; see the recorded tool evidence.\n\nKeep this draft");
    await go(ui.page, '.s-nav a[href="/library"]', "/library");
    await ui.page.locator(".s15-library-item").first().click();
    await ui.page.waitForFunction(() => document.querySelector("#s15-detail")?.hasAttribute("open"));
    expect(await ui.page.locator("#s15-detail").textContent()).toContain("wrote hello.txt (6 bytes)");
    await ui.page.locator("#s15-detail [data-s15-close]").click();
    await ui.page.waitForFunction(() => !document.querySelector("#s15-detail[open]"));
    await ui.page.locator(".s-nav [data-s15-search]").click();
    await ui.page.locator("#s15-search-input").fill("hello.txt");
    expect(await ui.page.locator("#s15-search .s15-search-results a:visible").count()).toBe(1);
    await ui.page.keyboard.press("Escape");
    await ui.page.locator('.s-nav a[href="/chats/new"]').click();
    await ui.page.waitForFunction(old => { const current = document.querySelector<HTMLElement>(".s15-app")?.dataset.conversation; return !!current && current !== old; }, conversation);
    expect(new URL(ui.page.url()).pathname).not.toBe("/chats/new");
    expect(await ui.page.evaluate(() => Reflect.get(window, "s15DocumentMarker"))).toBe("same-document");
    expect(await ui.page.locator("#s15-text").inputValue()).toBe("");
    expect(ui.mutations).toEqual([]); expect(ui.external).toEqual([]); expect(ui.errors).toEqual([]);
  } finally { await clean(ui.context); fixture.cleanup(); }
}, 30000);

browserTest("exact approval re-reads revisions on overlay return and dispatches once through the native form", async () => {
  const fixture = actionsFixture(); await fixture.hold({}, "Send the prepared note");
  const ui = await surface(fixture.handler, () => fixture.app.drain());
  try {
    await ui.page.goto(`${origin}/chats/${conversationId}`); await ready(ui.page);
    const link = ui.page.locator('.s15-slip-compact a[href^="/actions/"]').first();
    await link.click(); await ui.page.waitForFunction(() => document.querySelector("#s15-detail[open] input[name=actionHash]"));
    const firstRevision = await ui.page.locator('#s15-detail input[name=revision]').first().inputValue();
    expect(firstRevision).toBe("1");
    expect(await ui.page.evaluate(() => document.activeElement?.getAttribute("data-s15-original-id"))).toBe("s15-slip-title");
    const revised = fixture.revise({ payload: { to: "fixture-recipient", body: "Changed exact fixture content" } });
    await ui.page.locator("#s15-detail [data-s15-close]").click(); await ui.page.waitForFunction(() => !document.querySelector("#s15-detail[open]"));
    await ui.page.goForward();
    await ui.page.waitForFunction(() => document.querySelector('#s15-detail input[name=revision]')?.getAttribute("value") === "2");
    expect(await ui.page.locator('#s15-detail input[name=actionHash]').first().inputValue()).toBe(revised.action.actionHash);
    expect(await ui.page.locator("#s15-detail").textContent()).toContain("Changed exact fixture content");
    await snapshot(ui.page, "desktop-exact-review");
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      await ui.page.setViewportSize(viewport);
      await ui.page.locator("#s15-detail").evaluate(async element => { await Promise.allSettled(element.getAnimations({ subtree: true }).filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished)); });
      const bounds = (await ui.page.locator("#s15-detail").boundingBox())!;
      expect(Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2)).toBeLessThan(1);
      expect(Math.abs(bounds.y + bounds.height / 2 - viewport.height / 2)).toBeLessThan(1);
      expect(bounds.width).toBeLessThanOrEqual(viewport.width - 16);
      if (viewport.width === 390) await snapshot(ui.page, "mobile-exact-review");
    }
    await ui.page.setViewportSize({ width: 1440, height: 1000 });
    expect(ui.mutations).toEqual([]); expect(fixture.f.calls).toBe(0);
    // Returning before a pending GET completes cannot reopen a dismissed authority surface.
    await ui.page.locator("#s15-detail [data-s15-close]").click(); await ui.page.waitForFunction(() => !document.querySelector("#s15-detail[open]"));
    let release!: () => void, started!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
    await ui.context.route("**/actions/**", async route => { started(); await delayed; await route.fallback(); });
    await ui.page.goForward(); await requested; await ui.page.goBack(); release();
    await ui.page.waitForFunction(() => !history.state?.detail && !document.querySelector("#s15-detail[open]"));
    await ui.context.unroute("**/actions/**");
    await ui.page.goForward(); await ui.page.waitForFunction(() => document.querySelector('#s15-detail[open] input[name=revision]')?.getAttribute("value") === "2");
    // Exact controls stay after their exact content; motion never focuses a decision button.
    expect(await ui.page.evaluate(() => { const dialog = document.querySelector("#s15-detail")!; const exact = dialog.querySelector(".s-exact")!, controls = dialog.querySelector(".s-strip")!; return !!(exact.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING); })).toBe(true);
    await ui.page.locator('#s15-detail form[action="/s15/forms/action/decide"]:has(input[name="decision"][value="approve"]) button').click();
    await ui.page.waitForFunction(() => !document.querySelector("#s15-detail[open]"));
    expect(ui.mutations).toEqual(["/s15/forms/action/decide"]); expect(fixture.f.calls).toBe(1);
    expect(ui.external).toEqual([]); expect(ui.errors).toEqual([]);
  } finally { await clean(ui.context); fixture.cleanup(); }
}, 30000);

browserTest("slow navigation cannot overwrite a later page; blocked storage and missing View Transitions keep navigation usable", async () => {
  const fixture = webFixture(), conversation = newId(); await fixture.send(conversation, "Create hello.txt containing hello."); await fixture.app.drain();
  const ui = await surface(fixture.handler, () => fixture.app.drain());
  let release!: () => void, started!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  try {
    await ui.page.addInitScript(() => {
      Object.defineProperty(document, "startViewTransition", { value: undefined });
      Object.defineProperty(Storage.prototype, "setItem", { value() { throw new DOMException("Fixture storage blocked", "QuotaExceededError"); } });
    });
    await ui.page.goto(`${origin}/chats/${conversation}`); await ready(ui.page);
    await ui.page.locator("#s15-text").fill("Unsaved local draft");
    expect(await ui.page.locator("[data-draft-status]").textContent()).toBe(th["s14.plain.draft_unavailable"]);
    await ui.context.route("**/memory", async route => { started(); await delayed; await route.fallback(); });
    await ui.page.locator('.s-nav a[href="/memory"]').click(); await requested;
    await go(ui.page, '.s-nav a[href="/library"]', "/library"); release();
    expect(await ui.page.locator(".s-hdr h1").textContent()).toBe(th["s15.library.title"]);
    await ui.page.locator(".s15-library-item").first().click(); await ui.page.waitForFunction(() => document.querySelector("#s15-detail[open]"));
    await ui.page.emulateMedia({ reducedMotion: "reduce" });
    await ui.page.waitForFunction(() => matchMedia("(prefers-reduced-motion: reduce)").matches && document.getAnimations().every(animation => animation.playState !== "running"));
    expect(await ui.page.evaluate(() => Object.keys(history.state).sort())).toEqual(["depth", "detail", "s15"]);
    expect(ui.mutations).toEqual([]); expect(ui.external).toEqual([]); expect(ui.errors).toEqual([]);
  } finally { release(); await clean(ui.context); fixture.cleanup(); }
}, 30000);

browserTest("a pending composer send completes once without overwriting the next conversation or its draft", async () => {
  const fixture = webFixture(), conversation = newId();
  let release!: () => void, started!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; }), requested = new Promise<void>(resolve => { started = resolve; });
  const ui = await surface(fixture.handler, () => fixture.app.drain());
  try {
    await ui.context.route("**/s15/forms/message", async route => { started(); await delayed; await route.fallback(); });
    await ui.page.goto(`${origin}/chats/${conversation}`); await ready(ui.page);
    await ui.page.locator("#s15-text").fill("Create hello.txt containing hello.");
    const originalRequest = await ui.page.locator('#s15-composer input[name="requestId"]').inputValue();
    const sent = ui.page.waitForResponse(response => new URL(response.url()).pathname === "/s15/forms/message");
    void sent.catch(() => {});
    await ui.page.locator(".s-send").click(); await requested;
    expect(await ui.page.locator("#s15-text").evaluate((area: HTMLTextAreaElement) => area.readOnly)).toBe(true);
    await ui.page.locator('.s-nav a[href="/chats/new"]').click();
    await ui.page.waitForFunction(old => { const current = document.querySelector<HTMLElement>(".s15-app")?.dataset.conversation; return !!current && current !== old; }, conversation);
    await ui.page.locator("#s15-text").fill("Next conversation draft");
    await ui.page.goBack(); await ui.page.waitForFunction(old => document.querySelector<HTMLElement>(".s15-app")?.dataset.conversation === old, conversation);
    expect(await ui.page.locator("#s15-text").evaluate((area: HTMLTextAreaElement) => area.readOnly)).toBe(true);
    expect(await ui.page.locator('#s15-composer input[name="requestId"]').inputValue()).toBe(originalRequest);
    await ui.page.goForward(); await ui.page.waitForFunction(old => document.querySelector<HTMLElement>(".s15-app")?.dataset.conversation !== old, conversation);
    expect(await ui.page.locator("#s15-text").inputValue()).toBe("Next conversation draft"); release();
    expect((await sent).status()).toBe(200);
    await ui.page.waitForFunction(old => !localStorage.getItem(`s15-draft:${old}`), conversation);
    expect(await ui.page.locator("#s15-text").inputValue()).toBe("Next conversation draft");
    expect(fixture.ports.conversation.view(fixture.actor, conversation).rows).toHaveLength(1); expect(fixture.counts().calls).toBe(1);
    await ui.page.goBack(); await ui.page.waitForFunction(old => document.querySelector<HTMLElement>(".s15-app")?.dataset.conversation === old, conversation);
    expect(await ui.page.locator(".s15-row").count()).toBe(1); expect(await ui.page.locator(".s15-result").textContent()).toContain("Finished;");
    expect(ui.mutations).toEqual(["/s15/forms/message"]); expect(ui.external).toEqual([]); expect(ui.errors).toEqual([]);
  } finally { release(); await clean(ui.context); fixture.cleanup(); }
}, 30000);

browserTest("mobile reduced-motion and no-script surfaces retain real links and the composer without overflow", async () => {
  const fixture = webFixture(), conversation = newId(); await fixture.send(conversation, "Create hello.txt containing hello."); await fixture.app.drain();
  for (const script of [true, false]) {
    const ui = await surface(fixture.handler, () => fixture.app.drain(), { mobile: true, motion: false, script });
    try {
      await ui.page.goto(`${origin}/chats/${conversation}`); if (script) await ready(ui.page);
      if (script) await snapshot(ui.page, "mobile-conversation");
      expect(await ui.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await ui.page.locator("#s15-text").evaluate(area => getComputedStyle(area).fontSize)).toBe("16px");
      await ui.page.locator(".s15-attachment-limit summary").click();
      expect(await ui.page.locator(".s15-attachment-limit").textContent()).toContain("S15");
      expect(await ui.page.locator('input[type="file"]').count()).toBe(0);
      if (script) {
        await ui.page.locator(".s-mobile-nav > summary").click();
        await ui.page.locator('.s-mobile-nav a[href="/library"]').click(); await ui.page.waitForURL(`${origin}/library`);
        await ui.page.locator(".s15-library-item").first().click(); await ui.page.waitForFunction(() => document.querySelector("#s15-detail[open]"));
        expect(await ui.page.evaluate(() => document.getAnimations().filter(animation => animation.playState === "running").length)).toBe(0);
        expect(await ui.page.evaluate(() => document.querySelector("#s15-detail")!.scrollWidth <= innerWidth)).toBe(true);
      } else {
        await ui.page.locator("[data-s15-quote]").first().click(); await ui.page.waitForURL(url => url.searchParams.has("quote"));
        expect(await ui.page.locator("#s15-text").inputValue()).toStartWith("> Finished;");
        expect(await ui.page.locator('form[action="/s15/forms/message"]').count()).toBe(1);
        await ui.page.locator(".s-mobile-nav > summary").click(); await ui.page.locator(".s-mobile-nav [data-s15-search]").click();
        await ui.page.waitForURL(`${origin}/search`);
        await ui.page.locator("#s15-page-search-input").fill("hello.txt"); await ui.page.locator('#main-content form[action="/search"] button').click();
        await ui.page.waitForURL(url => url.searchParams.get("q") === "hello.txt");
        expect(await ui.page.locator("#main-content .s15-search-results a").count()).toBe(1);
      }
      expect(ui.mutations).toEqual([]); expect(ui.external).toEqual([]); expect(ui.errors).toEqual([]);
    } finally { await clean(ui.context); }
  }
  fixture.cleanup();
}, 30000);
