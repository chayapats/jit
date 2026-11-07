import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import type { VmManagement } from "../src/s15/vm/types";
import { en } from "../src/i18n/en";
import { th } from "../src/i18n/th";

// TEAM16-01 real React bundle: the computers page in English (desktop) and Thai (mobile), keyboard confirm/cancel,
// sleep now, a Bot's private computer and retiring it. Opt-in like the other S16 browser suites.
const browserTest = process.env.JIT_S16_BROWSER_TESTS === "1" ? test : test.skip;
let browser: Browser;
beforeAll(async () => { if (process.env.JIT_S16_BROWSER_TESTS === "1") browser = await chromium.launch({ executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true }); });
afterAll(async () => { await browser?.close(); }, 30000);

browserTest.each([1440, 390])("actual S16 computers page: scopes, sleep now and retiring a private computer at width %i", async width => {
  const second: VmManagement = { async inspect() { return { state: "running", identity: "fixture2", boot: "boot", cpuCount: 2, memoryBytes: 1e9, diskBytes: 1e9, network: "isolated", nicMac: "52:54:00:12:34:56" }; }, async stop() {}, async start() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  const f = await composedFixture("default", false, undefined, o => ({ ...o, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, vm: { ...o.vm, managers: new Map([...o.vm.managers, ["manager2", second]]) } }));
  f.service.vmStore.save({ ...f.service.vmStore.registration("vm"), id: "vm2", managerId: "manager2", machineIdentity: "fixture2" });
  f.service.computerScopes!.assignPrivate("vm2", "specialist");
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
    await page.goto("http://localhost:3099/s16/computers");
    await page.getByRole("heading", { name: copy["s16.computers.title"], level: 1 }).waitFor();
    await page.getByText(copy["s16.computers.lead"].replace("{minutes}", "30"), { exact: true }).waitFor();
    const shared = page.getByRole("article", { name: copy["s16.computers.shared"] }), mine = page.getByRole("article", { name: copy["s16.computers.private"].replace("{bot}", "specialist") });
    await shared.getByText(copy["s16.computers.state.running"], { exact: true }).waitFor();
    await mine.waitFor();
    const bots = page.locator(".computer-bots li");
    expect(await bots.count()).toBe(2);
    await bots.filter({ hasText: copy["s16.computers.mainBot"] }).getByText(copy["s16.computers.usesShared"], { exact: true }).waitFor();
    await bots.filter({ hasText: "specialist" }).getByText(copy["s16.computers.usesPrivate"], { exact: true }).waitFor();
    expect(await noOverflow()).toBe(true);

    // Sleep now: one explicit command, then the real observed state.
    await shared.getByRole("button", { name: copy["s16.computers.sleepNow"], exact: true }).click();
    await shared.getByText(copy["s16.computers.state.sleeping"], { exact: true }).waitFor();
    await shared.getByText(copy["s16.computers.sleepingNote"], { exact: true }).waitFor();
    expect(f.service.vmStore.registration("vm")).toMatchObject({ state: "stopped", reason: "vm_idle" });

    // Retire: the confirmation is keyboard-reachable; Escape cancels and returns focus without a command.
    const retire = bots.filter({ hasText: "specialist" }).getByRole("button", { name: copy["s16.computers.retire"], exact: true });
    await retire.focus(); await page.keyboard.press("Enter");
    const confirm = page.getByRole("group", { name: copy["s16.computers.retire"] }); await confirm.waitFor();
    await page.keyboard.press("Escape"); await confirm.waitFor({ state: "detached" });
    expect(await retire.evaluate(element => element === document.activeElement)).toBe(true);
    expect(f.service.computerScopes!.assigned("specialist")).toEqual(["vm2"]);
    await retire.click(); await page.getByRole("button", { name: copy["s16.computers.confirmRetire"], exact: true }).click();
    await bots.filter({ hasText: "specialist" }).getByText(copy["s16.computers.usesShared"], { exact: true }).waitFor();
    await mine.getByText(copy["s16.computers.retired"], { exact: true }).waitFor();
    expect(f.service.computerScopes!.assigned("specialist")).toEqual([]);
    expect(await noOverflow()).toBe(true);
    // The rail entry opens the same page.
    if (width === 1440) { await page.goto("http://localhost:3099/s16"); await page.getByRole("button", { name: copy["s16.nav.computers"], exact: true }).click(); await page.waitForURL("http://localhost:3099/s16/computers"); }
    expect(errors).toEqual([]); expect(external).toEqual([]);
  } finally { await context.close(); await f.close(); }
}, 60000);
