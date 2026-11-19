import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { composedFixture } from "./fixtures/s15-composition";
import { en } from "../src/i18n/en";
import { connectDesktopWindow, desktopIgnoredDefaults, openDesktopSession } from "../src/s16/desktop/launcher";
import { openDesktopConnection } from "../src/s16/desktop/connection";
import { th } from "../src/i18n/th";
import { activeNativeDesktop, installNativeDesktop } from "../src/s16/desktop/installation";

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
  const browserPath = process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  let host = { openDesktopSession, connectDesktopWindow };
  if (process.env.JIT_S16_DESKTOP_ARTIFACT) {
    installNativeDesktop({ artifact: process.env.JIT_S16_DESKTOP_ARTIFACT, root: profile, runtime: { bun: process.execPath, browser: browserPath, locale: "en", service: origin } });
    const selected = activeNativeDesktop(profile); host = await import(pathToFileURL(join(selected.directory, "main.js")).href);
  }
  const session = await host.openDesktopSession({ root: profile, service: origin, browser: browserPath, headless: process.env.JIT_DESKTOP_HEADED !== "1", locale: "en" });
  const context = session.context;
  context.setDefaultTimeout(10000);
  const cdp = session.cdp, manifestId = origin + "/s16/";
  let installed = false;
  try {
    const cookie = f.ownerCookie.slice("jit_s14=".length);
    await context.addCookies([{ name: "jit_s14", value: cookie, url: origin, httpOnly: true, sameSite: "Strict" }]);
    const connected = await host.connectDesktopWindow(session), app = await connected.ready; installed = true;
    const release = await (await fetch(origin + "/s16/desktop-release.json")).json();
    await app.locator('[data-desktop-state="ready"]').waitFor({ state: "attached" });
    const command = await cdp.send("Browser.getBrowserCommandLine");
    expect(command.arguments).toContain("--remote-debugging-pipe"); expect(command.arguments).not.toContain("--no-sandbox");
    expect(command.arguments.some((arg: string) => arg.startsWith("--remote-debugging-port") || desktopIgnoredDefaults.includes(arg))).toBe(false);
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
    // The refused navigation can leave Chrome's error-page target mid-transition. Close it with the owned browser,
    // after uninstall, rather than awaiting a per-page close during that native transition.
    phase("adversarial navigation verified");
  } finally {
    phase("uninstalling temporary app"); if (installed) await cdp.send("PWA.uninstall", { manifestId }).catch(() => {});
    phase("closing browser"); await session.close(); phase("stopping fixture HTTP"); await server.stop(true); await outside.stop(true); phase("closing owning service"); await f.close(); rmSync(profile, { recursive: true, force: true }); phase("cleanup complete");
  }
}, 30000);

browserTest.each(["en", "th"] as const)("connection window chooses only a service in %s and owns no authenticated session", async locale => {
  const window = await openDesktopConnection({ browser: process.env.JIT_BROWSER_EXECUTABLE || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", locale, headless: true });
  const copy = locale === "en" ? en : th;
  try {
    await window.page.getByLabel(copy["s16.desktop.address"], { exact: true }).fill("https://user:password@jit.example.test");
    await window.page.getByRole("button", { name: copy["s16.desktop.connect"], exact: true }).click();
    await window.page.getByText(copy["s16.desktop.addressInvalid"], { exact: true }).waitFor();
    expect(await window.page.context().cookies()).toEqual([]);
    const other = await window.page.context().newPage();
    expect(await other.evaluate(() => typeof Reflect.get(window, "jitDesktopConnect"))).toBe("undefined"); await other.close();
    await window.page.getByLabel(copy["s16.desktop.address"], { exact: true }).fill("https://jit.example.test/s16/");
    await window.page.getByRole("button", { name: copy["s16.desktop.connect"], exact: true }).focus(); await window.page.keyboard.press("Enter");
    expect(await window.choice).toBe("https://jit.example.test");
    await window.page.setViewportSize({ width: 390, height: 800 }); expect(await window.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await window.close(); }
  expect(window.page.isClosed()).toBe(true);
}, 30000);
