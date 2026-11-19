import type { BrowserContext, Page, Request as BrowserRequest } from "playwright-core";
import type { DesktopOwnerWindow, DesktopOwnerWindowRequest } from "./owner-window";

/** Public help is a single authored destination, never an open-anything capability. */
export const desktopGithubHelp = "https://github.com/settings/personal-access-tokens/new";
interface Capability { requestId: string; url: string; sourceId: string; revision: number; state: string; created: number; expires: number; used: boolean }
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Native controller only: trusted HTTP receipt capture and one-use manual OAuth handoff, without Jit-cookie transfer. */
export interface DesktopOwnerLinks { capture(request: BrowserRequest, status: number, body: Uint8Array): void; close(): Promise<void> }

/**
 * Installs one bounded native callback. A page/model URL creates no authority: OAuth requires a captured successful
 * actual service receipt plus a fresh current-owner/source read. Host/window factories are trusted native seams.
 */
export async function installDesktopOwnerLinks(context: BrowserContext, options: { origin: string; open(request: DesktopOwnerWindowRequest): Promise<DesktopOwnerWindow>; now?: () => number }): Promise<DesktopOwnerLinks> {
  const now = options.now ?? (() => performance.now()), capabilities = new WeakMap<Page, Map<string, Capability>>(), windows = new Set<DesktopOwnerWindow>();
  const pending = new Set<Promise<DesktopOwnerWindow>>(), closingWindows = new WeakMap<DesktopOwnerWindow, Promise<void>>();
  const closeWindow = (window: DesktopOwnerWindow) => { let closing = closingWindows.get(window); if (!closing) { closing = Promise.resolve().then(() => window.close()); closingWindows.set(window, closing); } return closing; };
  let closed = false, opening = 0;
  const currentPage = (page: Page) => { try { const url = new URL(page.url()); return !page.isClosed() && url.origin === options.origin && url.pathname === "/s16/connections" && !url.search; } catch { return false; } };
  const fresh = async (cap: Capability, returned = false): Promise<boolean> => {
    try {
      const response = await context.request.get(options.origin + "/api/s16/client/connections", { maxRedirects: 0, maxRetries: 0, timeout: 10000 });
      try {
        if (!response.ok()) return false;
        const bytes = await response.body(); if (bytes.length > 2 * 1024 * 1024) return false;
        const data: unknown = JSON.parse(bytes.toString());
        if (!record(data) || data.contract !== "s16-client-connections/v1" || !Array.isArray(data.sources)) return false;
        return data.sources.some((source: unknown) => {
          if (!record(source) || source.id !== cap.sourceId || !record(source.auth) || source.auth.kind !== "oauth") return false;
          return source.revision === cap.revision && source.state === "authorizing" || returned && source.revision === cap.revision + 1 && source.state === "reconnect_required" && source.code === "source_login_declined";
        });
      }
      finally { await response.dispose(); }
    } catch { return false; }
  };
  await context.exposeBinding("jitDesktopOwnerLink", async (source, value: unknown) => {
    if (closed || typeof value !== "string" || value.length > 8192 || source.frame !== source.page.mainFrame() || !currentPage(source.page) || windows.size + opening >= 4) return { opened: false };
    opening++;
    try {
      const cap = capabilities.get(source.page)?.get(value);
      if (value === desktopGithubHelp) {
        // A host evaluation must not itself synthesize the activation it is checking.
        const cdp = await context.newCDPSession(source.page);
        try { const result = await cdp.send("Runtime.evaluate", { expression: "navigator.userActivation.isActive", returnByValue: true, userGesture: false }); if (result.result.value !== true) return { opened: false }; }
        finally { await cdp.detach(); }
      } else {
        const time = now();
        if (!cap || cap.used || time < cap.created || time > cap.expires) return { opened: false };
        cap.used = true;
        if (!await fresh(cap) || !currentPage(source.page) || closed) return { opened: false };
      }
      if (closed || !currentPage(source.page) || cap && (now() < cap.created || now() > cap.expires)) return { opened: false };
      const creating = options.open({ url: value, origin: options.origin, callback: cap ? { state: cap.state, sourceId: cap.sourceId } : null, async returned(target) {
        if (closed || !cap || !currentPage(source.page) || !await fresh(cap, true) || !currentPage(source.page) || closed || now() < cap.created || now() > cap.expires) return;
        if (target !== `/s16/connections#oauth=${cap.sourceId}` && target !== "/s16/connections#oauth_error=source_oauth_stale") return;
        await source.page.goto(options.origin + target, { waitUntil: "domcontentloaded" });
        // The caller is already on Connections: a fragment-only goto does not remount the client's OAuth bootstrap.
        await source.page.reload({ waitUntil: "domcontentloaded" });
      } });
      pending.add(creating);
      let window: DesktopOwnerWindow;
      try { window = await creating; } finally { pending.delete(creating); }
      if (closed) { await closeWindow(window); return { opened: false }; }
      windows.add(window); void window.closed.then(() => windows.delete(window), () => windows.delete(window));
      return { opened: true };
    } catch { return { opened: false }; } finally { opening--; }
  });
  return {
    capture(request, status, body) {
      if (closed || status !== 200 || request.method() !== "POST" || request.url() !== options.origin + "/api/s16/client/connections/commands" || body.byteLength > 2 * 1024 * 1024) return;
      try {
        const frame = request.frame(), page = frame.page(); if (frame !== page.mainFrame() || !currentPage(page)) return;
        const command = request.postDataJSON() as unknown, receipt: unknown = JSON.parse(new TextDecoder().decode(body));
        if (!record(command) || command.contract !== "s16-connection-command/v1" || !token(command.requestId) || !["source.add", "source.oauth_begin"].includes(String(command.kind)) || command.kind === "source.add" && (!record(command.auth) || command.auth.kind !== "oauth")) return;
        if (!record(receipt) || receipt.contract !== "s16-connection-receipt/v1" || receipt.requestId !== command.requestId || receipt.kind !== command.kind || typeof receipt.authorize !== "string" || receipt.authorize.length > 8192 || !record(receipt.source)) return;
        const source = receipt.source;
        if (!token(source.id) || !Number.isSafeInteger(source.revision) || Number(source.revision) < 1 || source.state !== "authorizing" || !record(source.auth) || source.auth.kind !== "oauth" || command.kind === "source.oauth_begin" && command.sourceId !== source.id) return;
        const url = new URL(receipt.authorize), dev = new URL(options.origin).protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
        if (url.origin === options.origin || url.username || url.password || url.hash || url.protocol !== "https:" && !(dev && url.protocol === "http:")) return;
        const state = url.searchParams.get("state");
        if (!token(state) || url.searchParams.getAll("state").length !== 1 || url.searchParams.getAll("redirect_uri").length !== 1 || url.searchParams.get("redirect_uri") !== options.origin + "/s16/connections/oauth/callback" || url.searchParams.getAll("code_challenge_method").length !== 1 || url.searchParams.get("code_challenge_method") !== "S256" || url.searchParams.getAll("code_challenge").length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get("code_challenge") ?? "") || url.searchParams.getAll("response_type").length !== 1 || url.searchParams.get("response_type") !== "code") return;
        const time = now(), saved = capabilities.get(page) ?? new Map<string, Capability>();
        for (const [key, value] of saved) if (time > value.expires) saved.delete(key);
        if ([...saved.values()].some(value => value.requestId === command.requestId) || saved.size >= 8) return;
        saved.set(url.href, { requestId: command.requestId, url: url.href, sourceId: source.id, revision: Number(source.revision), state, created: time, expires: time + 600000, used: false }); capabilities.set(page, saved);
      } catch { /* Unprovable receipt/initiator creates no capability. */ }
    },
    async close() { closed = true; await Promise.allSettled([...windows].map(closeWindow).concat([...pending].map(creating => creating.then(closeWindow)))); windows.clear(); },
  };
}
