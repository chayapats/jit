import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import type { Locale } from "../../i18n";
import { desktopLaunchUrl, guardDesktopContext } from "./boundary";
import { desktopProfile, leaseDesktopProfile, prepareDesktopStartup } from "./storage";
import { desktopBrowser } from "./executable";
export { desktopBrowser, desktopExecutable } from "./executable";
import { desktopIgnoredDefaults } from "./browser-options";
import { installDesktopOwnerLinks } from "./owner-links";
import { openDesktopOwnerWindow, type DesktopOwnerWindow, type DesktopOwnerWindowRequest } from "./owner-window";
export { desktopIgnoredDefaults } from "./browser-options";

/** Trusted native host session; none of this object is exposed to a renderer. */
export interface DesktopSession { context: BrowserContext; cdp: CDPSession; origin: string; profileId: string; browserVersion: string; close(): Promise<void>; closed: Promise<void> }

/**
 * Starts only the managed exact-service profile, sandbox and private debugging pipe. The explicit headless option
 * belongs to opt-in conformance callers; product CLI never accepts it or arbitrary browser flags. No native permission
 * is pre-granted and no owner profile is imported. The only service binding is the receipt-bound owner-link handoff.
 */
export async function openDesktopSession(options: { root: string; service: string; browser: string; locale: Locale; headless?: boolean; /** Trusted native host integration/conformance seam. Installed config and renderers cannot supply it. */ ownerWindow?: (request: DesktopOwnerWindowRequest) => Promise<DesktopOwnerWindow> }): Promise<DesktopSession> {
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("desktop_platform_unsupported");
  const executablePath = desktopBrowser(options.browser), profile = desktopProfile(options.root, options.service), release = leaseDesktopProfile(profile.directory);
  let context: BrowserContext | undefined;
  let phase = "profile";
  try {
    const userDataDir = prepareDesktopStartup(profile.directory);
    phase = "launch";
    context = await chromium.launchPersistentContext(userDataDir, { executablePath, headless: options.headless ?? false, chromiumSandbox: true, locale: options.locale === "en" ? "en-US" : "th-TH", viewport: null, ignoreDefaultArgs: [...desktopIgnoredDefaults], args: ["--no-first-run", "--enable-automation"] });
    if (context.pages().some(page => page.url() !== "about:blank")) throw new Error("desktop_startup_not_blank");
    const ownerLinks = await installDesktopOwnerLinks(context, { origin: profile.origin, open: options.ownerWindow ?? (request => openDesktopOwnerWindow(request, { browser: executablePath, ...(options.headless === undefined ? {} : { headless: options.headless }) })) });
    phase = "guard"; await guardDesktopContext(context, profile.origin, ownerLinks.capture);
    const browser = context.browser()!, cdp = await browser.newBrowserCDPSession();
    phase = "command_line"; const command = await cdp.send("Browser.getBrowserCommandLine") as { arguments: string[] };
    if (!command.arguments.includes("--remote-debugging-pipe") || command.arguments.some(arg => arg.startsWith("--remote-debugging-port") || arg === "--no-sandbox" || desktopIgnoredDefaults.includes(arg))) throw new Error("desktop_browser_boundary_invalid");
    // Restore Chrome's ordinary user-visible download behavior, rather than Playwright's temporary test directory.
    phase = "downloads"; await cdp.send("Browser.setDownloadBehavior", { behavior: "default", eventsEnabled: true });
    const closed = Promise.withResolvers<void>();
    context.once("close", () => { void ownerLinks.close().finally(() => { release(); closed.resolve(); }); });
    return { context, cdp, origin: profile.origin, profileId: profile.id, browserVersion: browser.version(), closed: closed.promise, async close() { await context!.close(); await closed.promise; } };
  } catch (error) { await context?.close().catch(() => {}); release(); throw new Error(error instanceof Error && /^desktop_[a-z_]+$/.test(error.message) ? error.message : `desktop_browser_${phase}_unavailable`); }
}

/** Installed standalone window, or a protected sign-in window waiting for the actual owner. */
export interface DesktopWindow { page: Page; ready: Promise<Page> }

/**
 * Connects through current service authentication. Sign-in is a human browser flow; only read-only session/package
 * observations precede installation. PWA install/launch changes client presentation, never work or approval authority.
 */
export async function connectDesktopWindow(session: DesktopSession, link?: string): Promise<DesktopWindow> {
  const target = desktopLaunchUrl(session.origin, link), context = session.context, page = context.pages()[0] ?? await context.newPage();
  const ready = Promise.withResolvers<Page>(); void ready.promise.catch(() => {});
  let completed = false, checking = false;
  const check = async () => {
    if (completed || checking || page.isClosed() || new URL(page.url()).origin !== session.origin) return;
    checking = true;
    try {
      const response = await context.request.get(session.origin + "/api/s16/client/session", { maxRedirects: 0, maxRetries: 0, timeout: 10000 });
      const authenticated = response.ok(); await response.dispose(); if (!authenticated) return;
      completed = true; page.removeListener("domcontentloaded", changed);
      if (page.url() !== target) await page.goto(target, { waitUntil: "domcontentloaded" });
      await page.locator('[data-desktop-state="ready"], [data-desktop-state="update"]').waitFor({ state: "attached", timeout: 30000 });
      const manifestId = session.origin + "/s16/";
      try { await session.cdp.send("PWA.getOsAppState", { manifestId }); }
      catch { await session.cdp.send("PWA.install", { manifestId, installUrlOrBundleUrl: target }); }
      await session.cdp.send("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" });
      const opened = context.waitForEvent("page", { timeout: 10000 });
      await session.cdp.send("PWA.launch", { manifestId, url: target });
      const app = await opened; await app.waitForURL(target);
      if (!await app.evaluate(() => matchMedia("(display-mode: standalone)").matches)) throw new Error("desktop_standalone_unavailable");
      await page.close(); ready.resolve(app);
    } catch { completed = true; ready.reject(new Error("desktop_connection_unavailable")); }
    finally { checking = false; }
  };
  const changed = () => { void check(); };
  page.on("domcontentloaded", changed); page.once("close", () => { if (!completed) ready.reject(new Error("desktop_connection_closed")); });
  const response = await page.goto(target, { waitUntil: "domcontentloaded" });
  if (response?.status() === 401 || response?.status() === 403) await page.goto(session.origin + "/s14/login", { waitUntil: "domcontentloaded" });
  await check();
  return { page, ready: ready.promise };
}
