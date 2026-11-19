import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { composedFixture } from "./fixtures/s15-composition";
import { en } from "../src/i18n/en";
import { guardDesktopContext } from "../src/s16/desktop/boundary";

const browserTest = process.env.JIT_S16_DESKTOP_TESTS === "1" ? test : test.skip;
const phase = (value: string) => { if (process.env.JIT_DESKTOP_TRACE === "1") console.error("desktop proof: " + value); };
browserTest("installs and launches the actual client in a standalone browser-owned window", async () => {
  let f: Awaited<ReturnType<typeof composedFixture>> | undefined;
  let outsideRequests = 0;
  const outside = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { outsideRequests++; return new Response("controlled destination"); } });
  const outsideUrl = `http://127.0.0.1:${outside.port}/`;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/controlled-redirect" ? Response.redirect(outsideUrl, 302) : f ? f.service.fetch(request) : new Response("", { status: 503 }) });
  const origin = `http://127.0.0.1:${server.port}`;
  const profile = mkdtempSync(join(tmpdir(), "jit-desktop-browser-"));
  f = await composedFixture("default", false, undefined, options => ({ ...options, origin, files: {} }));
  const context = await chromium.launchPersistentContext(profile, { executablePath: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: process.env.JIT_DESKTOP_HEADED !== "1", locale: "en-US", args: ["--no-first-run", "--disable-background-networking"] });
  context.setDefaultTimeout(10000);
  await guardDesktopContext(context, origin);
  const browser = context.browser()!, cdp = await browser.newBrowserCDPSession(), manifestId = origin + "/s16/";
  let installed = false;
  try {
    const cookie = f.ownerCookie.slice("jit_s14=".length);
    await context.addCookies([{ name: "jit_s14", value: cookie, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const page = context.pages()[0] ?? await context.newPage(); await page.goto(manifestId);
    await page.locator('[data-desktop-state="ready"]').waitFor({ state: "attached" });
    const release = await (await fetch(origin + "/s16/desktop-release.json")).json();
    await cdp.send("PWA.install", { manifestId, installUrlOrBundleUrl: manifestId }); installed = true;
    await cdp.send("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" });
    const opened = context.waitForEvent("page");
    const launched = await cdp.send("PWA.launch", { manifestId });
    expect(typeof launched.targetId).toBe("string");
    const app = await opened;
    await app.waitForURL(manifestId); await app.locator('[data-desktop-state="ready"]').waitFor({ state: "attached" });
    expect(await app.evaluate(() => matchMedia("(display-mode: standalone)").matches)).toBe(true);
    expect(new URL(app.url()).origin).toBe(origin);
    expect(await cdp.send("PWA.getOsAppState", { manifestId })).toMatchObject({ fileHandlers: [] });
    await app.getByRole("button", { name: en["s16.common.refresh"], exact: true }).waitFor();
    const state = await app.evaluate(async () => {
      const names = await caches.keys();
      const entries = await Promise.all(names.map(async name => ({ name, urls: (await (await caches.open(name)).keys()).map(request => request.url) })));
      return { entries, localStorage: localStorage.length, indexedDb: (await indexedDB.databases()).map(db => db.name), sessionCookie: document.cookie };
    });
    const cache = state.entries.find(entry => entry.name.endsWith(release.id))!;
    expect(cache.urls).toHaveLength(release.assets.length + 1);
    expect(cache.urls.every(url => new URL(url).pathname.startsWith("/s16/assets/") || new URL(url).pathname === "/s16/.desktop-complete")).toBe(true);
    expect(state.localStorage).toBe(0); expect(state.sessionCookie).not.toContain(cookie); expect(f.vmCalls).toEqual([]);
    expect(await app.evaluate(() => Reflect.get(window, "require"))).toBeUndefined();
    expect(await app.evaluate(() => Reflect.get(window, "electron"))).toBeUndefined();
    const hostile = await context.newPage();
    await expect(hostile.goto(outsideUrl)).rejects.toThrow();
    await expect(hostile.goto(origin + "/controlled-redirect")).rejects.toThrow();
    expect(outsideRequests).toBe(0);
    expect(f.vmCalls).toEqual([]);
    phase("closing hostile window"); await hostile.close(); phase("hostile window closed");
  } finally {
    // Stop application traffic before uninstall. Keep one neutral tab so Chrome remains alive for the OS command.
    phase("closing application windows");
    const neutral = await context.newPage().catch(() => null);
    for (const page of context.pages()) if (page !== neutral) await page.close().catch(() => {});
    phase("uninstalling temporary app"); if (installed) await cdp.send("PWA.uninstall", { manifestId }).catch(() => {});
    phase("closing browser"); await context.close(); phase("stopping fixture HTTP"); await server.stop(true); await outside.stop(true); phase("closing owning service"); await f.close(); rmSync(profile, { recursive: true, force: true }); phase("cleanup complete");
  }
}, 30000);
