import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import type { VmScreenDevice, VmScreenInput } from "../src/s15/vm/screen";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

// DESK16-01 real React bundle: watch a computer's screen, take over, click and type (the field clears), send a key
// from the keyboard-capture region and hand back, in English (desktop) and Thai (mobile). Opt-in like the other S16
// browser suites.
const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);
/** Waits (bounded) until the scripted device recorded `count` inputs. */
async function inputs(sent: unknown[], count: number): Promise<void> { for (let i = 0; i < 100 && sent.length < count; i++) await Bun.sleep(50); expect(sent).toHaveLength(count); }

/** A real 1280×800 PNG (solid colour) so the browser decodes and lays out an actual frame. */
async function frame(): Promise<Uint8Array> {
  const page = await browser.newPage();
  try {
    const data = await page.evaluate(() => { const c = document.createElement("canvas"); c.width = 1280; c.height = 800; const g = c.getContext("2d")!; g.fillStyle = "#2b6cb0"; g.fillRect(0, 0, 1280, 800); return c.toDataURL("image/png"); });
    return new Uint8Array(Buffer.from(data.split(",")[1]!, "base64"));
  } finally { await page.close(); }
}

browserTest.each([1440, 390])("actual S16 computer screen: watch, take over, click, type and hand back at width %i", async width => {
  const png = await frame(), sent: VmScreenInput[] = [];
  const device: VmScreenDevice = { async unavailable() { return null; }, async capture() { return png; }, async send(input) { sent.push(input); } };
  const f = await composedFixture("default", false, undefined, o => ({ ...o, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, screen: {},
    vm: { ...o.vm, managers: new Map([...o.vm.managers].map(([id, manager]) => [id, Object.assign(manager, { screen: () => device })])) } }));
  const copy = width === 1440 ? en : th, locale = width === 1440 ? "en-US" : "th-TH";
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale, timezoneId: "Asia/Bangkok" });
  const errors: string[] = [], external: string[] = [];
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url()); if (url.origin !== "http://localhost:3099") { if (!url.protocol.startsWith("blob")) external.push(request.url()); await route.abort(); return; }
    const headers = { ...request.headers(), host: "localhost:3099" };
    const response = request.method() === "POST" ? await f.request(url.pathname + url.search, "POST", request.postDataJSON(), headers) : await f.request(url.pathname + url.search, request.method(), undefined, headers);
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const title = copy["s16.screen.title"].replace("{computer}", copy["s16.computers.shared"]);
  try {
    await page.goto("http://localhost:3099/s16/computers");
    await page.getByRole("button", { name: copy["s16.screen.watch"] }).click();
    const panel = page.getByRole("region", { name: title });
    await panel.getByRole("heading", { name: title }).waitFor();
    await panel.getByText(copy["s16.screen.state.agent"], { exact: true }).waitFor();
    const image = panel.getByRole("img", { name: copy["s16.screen.alt"].replace("{computer}", copy["s16.computers.shared"]) });
    await image.waitFor();
    expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1280);
    // Watching sends nothing to the computer.
    await image.click(); expect(sent).toEqual([]);
    await panel.getByRole("button", { name: copy["s16.screen.takeOver"] }).click();
    await panel.getByText(copy["s16.screen.driving"], { exact: true }).waitFor();
    await panel.getByText(copy["s16.screen.state.owner"], { exact: true }).waitFor();
    const box = (await image.boundingBox())!;
    await image.click({ position: { x: box.width / 2, y: box.height / 4 } });
    await inputs(sent, 1);
    expect(sent[0]).toMatchObject({ kind: "click", button: "left", double: false });
    const click = sent[0] as Extract<VmScreenInput, { kind: "click" }>;
    expect(Math.abs(click.x - 640)).toBeLessThanOrEqual(2); expect(Math.abs(click.y - 200)).toBeLessThanOrEqual(2);
    // A double click is one double click on the computer, never two singles or three presses.
    await image.dblclick({ position: { x: box.width / 2, y: box.height / 4 } });
    await inputs(sent, 2); await Bun.sleep(400);
    expect(sent).toHaveLength(2); expect(sent[1]).toMatchObject({ kind: "click", button: "left", double: true });
    const field = panel.getByLabel(copy["s16.screen.typeLabel"]);
    expect(await field.getAttribute("type")).toBe("password");
    await field.fill("Owner-Pass1"); await panel.getByRole("button", { name: copy["s16.screen.send"], exact: true }).click();
    await inputs(sent, 3);
    expect(sent[2]).toEqual({ kind: "text", text: "Owner-Pass1" }); expect(await field.inputValue()).toBe("");
    // Keyboard capture: Enter on the focused screen region reaches the computer as one key.
    await panel.locator(".screen-frame").focus(); await page.keyboard.press("Enter");
    await inputs(sent, 4);
    expect(sent[3]).toEqual({ kind: "key", keys: ["ret"] });
    expect(await noOverflow()).toBe(true);
    await panel.getByRole("button", { name: copy["s16.screen.handBack"] }).click();
    await panel.getByText(copy["s16.screen.state.agent"], { exact: true }).waitFor();
    await panel.getByRole("button", { name: copy["s16.screen.takeOver"] }).waitFor();
    await panel.getByRole("button", { name: copy["s16.screen.close"] }).click();
    await page.getByRole("button", { name: copy["s16.screen.watch"] }).waitFor();
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(copy["s16.screen.watch"]);
    expect(sent).toHaveLength(4);
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 60000);
