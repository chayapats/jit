import { chromium, type BrowserContext, type Page } from "playwright-core";
import { desktopBrowser } from "./executable";
import { desktopIgnoredDefaults } from "./browser-options";

/** An already-authorized owner handoff, never an arbitrary command or an authenticated Jit browser profile. */
export interface DesktopOwnerWindowRequest { url: string; origin: string; callback: { state: string; sourceId: string } | null; returned(target: string): Promise<void> }
/** Trusted native host handle. No member is exported to a page or a Bot. */
export interface DesktopOwnerWindow { close(): Promise<void>; closed: Promise<void> }

function callbackUrl(url: URL, request: DesktopOwnerWindowRequest): boolean {
  return !!request.callback && url.origin === request.origin && url.pathname === "/s16/connections/oauth/callback" && url.searchParams.getAll("state").length === 1 && url.searchParams.get("state") === request.callback.state;
}

/**
 * Opens a fresh disposable manual browser, with no Jit cookies, imported profile or native binding. The person owns
 * login/2FA. Only the actual owning service's matching callback response can resume the authenticated client.
 */
export async function openDesktopOwnerWindow(request: DesktopOwnerWindowRequest, options: { browser: string; headless?: boolean; /** Trusted host transport/observation seam, never an option accepted from a page or installed configuration. */ beforeNavigate?: (context: BrowserContext, page: Page) => Promise<void> }): Promise<DesktopOwnerWindow & { context: BrowserContext; page: Page }> {
  const browser = await chromium.launch({ executablePath: desktopBrowser(options.browser), headless: options.headless ?? false, chromiumSandbox: true, ignoreDefaultArgs: [...desktopIgnoredDefaults] });
  try {
    const context = await browser.newContext({ viewport: null }), page = await context.newPage(), ended = Promise.withResolvers<void>();
    browser.once("disconnected", () => ended.resolve());
    let returned = false;
    await context.route("**/*", async route => {
      try {
        const incoming = route.request(), url = new URL(incoming.url());
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) { await route.abort("blockedbyclient"); return; }
        if (url.origin !== request.origin) { await route.continue(); return; }
        if (!callbackUrl(url, request) || incoming.method() !== "GET" || !incoming.isNavigationRequest() || incoming.frame() !== page.mainFrame() || returned) { await route.abort("blockedbyclient"); return; }
        returned = true;
        // A development provider can share a hostname on another port: never forward even its cookies to Jit.
        // Consume the actual callback response without allowing Chrome to follow its redirect in the provider profile.
        await route.abort("blockedbyclient");
        const response = await context.request.get(url.href, { headers: { cookie: "" }, maxRedirects: 0, maxRetries: 0, timeout: 10000 });
        let target: string | undefined;
        try {
          target = response.headers().location;
          if (response.status() !== 303 || target !== `/s16/connections#oauth=${request.callback!.sourceId}` && target !== "/s16/connections#oauth_error=source_oauth_stale") return;
        } finally { await response.dispose().catch(() => {}); }
        // The browser's navigation is aborted; only the controller sends the single exact callback, without redirects.
        void browser.close().catch(() => {});
        // Browser disconnection fences every provider page. Waiting for the process-close RPC here can deadlock the
        // route's own connection teardown; cleanup continues independently after the authenticated client resumes.
        void ended.promise.then(() => request.returned(target!)).catch(() => {});
      } catch { await route.abort("failed").catch(() => {}); }
    });
    await context.routeWebSocket("**/*", socket => {
      const url = new URL(socket.url()), normalized = url.protocol === "wss:" ? "https:" + url.href.slice(4) : url.protocol === "ws:" ? "http:" + url.href.slice(3) : "";
      if (!normalized || new URL(normalized).origin === request.origin) { socket.close({ code: 1008, reason: "Service boundary" }); return; }
      socket.connectToServer();
    });
    // Network events include redirect hops which a Playwright route does not intercept. This browser has no Jit
    // session; refuse/close other Jit traffic, and observe the real callback rather than trusting provider content.
    context.on("request", incoming => {
      const url = new URL(incoming.url());
      if (url.origin === request.origin && !callbackUrl(url, request)) void browser.close().catch(() => {});
    });
    await options.beforeNavigate?.(context, page);
    void page.goto(request.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    return { context, page, closed: ended.promise, close: () => browser.close() };
  } catch { await browser.close().catch(() => {}); throw new Error("desktop_owner_window_unavailable"); }
}
