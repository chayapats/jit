import type { APIResponse, BrowserContext, Page } from "playwright-core";
import { desktopDocument } from "./release";

/** Canonical connection selection. A URL is a service identity, never an executable, credential or command. */
export function desktopService(value: string): string {
  if (value.length > 2048 || /[\s\\\u0000-\u001f]/.test(value)) throw new Error("desktop_service_invalid");
  let url: URL; try { url = new URL(value); } catch { throw new Error("desktop_service_invalid"); }
  if (url.username || url.password || url.search || url.hash || !["/", "/s16", "/s16/"].includes(url.pathname) || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("desktop_service_invalid");
  return url.origin;
}

/** A launch link only opens an existing S16 view of this service; it can never switch origin or decide an action. */
export function desktopLaunchUrl(origin: string, value?: string): string {
  const selected = desktopService(origin); let url: URL;
  try { url = new URL(value ?? "/s16/", selected); } catch { throw new Error("desktop_link_invalid"); }
  if (url.origin !== selected || url.username || url.password || url.search || url.hash || !desktopDocument(url.pathname)) throw new Error("desktop_link_invalid");
  return url.href;
}

const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);
/** Maximum buffered protected-service response, above the current file/audio contracts. Never a disk cache. */
export const desktopResponseBytes = 128 * 1024 * 1024;

/**
 * Installs the native exact-service boundary before opening a page. It covers popups, cross-port requests and
 * redirects. Playwright routes see only the first URL of a redirect chain, so we use zero-follow/zero-retry fetch
 * and never forward an unchecked Location to Chrome. No generic privileged renderer binding is installed.
 */
export async function guardDesktopContext(context: BrowserContext, service: string): Promise<void> {
  const origin = desktopService(service), redirects = new WeakMap<Page, number>();
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin || !["https:", "http:"].includes(url.protocol) || url.username || url.password) { await route.abort("blockedbyclient"); return; }
    if (!request.isNavigationRequest()) {
      // The protected context's request transport must never attach its cookie jar for a foreign/opaque document.
      let source: string | null = null;
      try { source = request.serviceWorker()?.url() ?? request.frame().url(); } catch { /* No proven initiator. */ }
      if (!source || new URL(source).origin !== origin) { await route.abort("blockedbyclient"); return; }
    }
    let response: APIResponse | undefined;
    try {
      response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 30000 });
      const status = response.status(), location = response.headers().location;
      if (status >= 300 && status < 400 && location) {
        const next = new URL(location, url);
        // Private fetches never follow a redirect. Navigation may use a fresh GET after a checked sign-in redirect.
        if (next.origin !== origin || next.username || next.password || !request.isNavigationRequest() || [307, 308].includes(status) && !["GET", "HEAD"].includes(request.method())) { await route.abort("blockedbyclient"); return; }
        const page = request.frame().page(), count = (redirects.get(page) ?? 0) + 1; redirects.set(page, count);
        if (count > 8) { await route.abort("blockedbyclient"); return; }
        const href = escape(next.href);
        await route.fulfill({ status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }, body: `<!doctype html><html><meta charset="utf-8"><title>Jit</title><meta http-equiv="refresh" content="0;url=${href}"><a href="${href}">Jit</a></html>` });
        return;
      }
      if (request.isNavigationRequest()) redirects.delete(request.frame().page());
      const declared = response.headers()["content-length"];
      if (declared && Number(declared) > desktopResponseBytes) { await route.abort("failed"); return; }
      const body = await response.body(); if (body.byteLength > desktopResponseBytes) { await route.abort("failed"); return; }
      await route.fulfill({ response, body });
    } catch { await route.abort("failed").catch(() => {}); }
    finally { await response?.dispose().catch(() => {}); }
  });
  await context.routeWebSocket("**/*", socket => {
    const url = new URL(socket.url());
    const httpOrigin = url.protocol === "wss:" ? "https:" + url.href.slice(4) : url.protocol === "ws:" ? "http:" + url.href.slice(3) : "";
    if (!httpOrigin || new URL(httpOrigin).origin !== origin || url.username || url.password) { socket.close({ code: 1008, reason: "Service boundary" }); return; }
    socket.connectToServer();
  });
}
