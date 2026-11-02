import { chromium, type BrowserContext, type Page, type Route, type ElementHandle } from 'playwright-core';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { BrokerResponse, BrowserMode, BrowserObservation, BrowserRequest, OwnerBrowserInput } from './types';
import { BrowserError } from './validation';

/** Private host request interception. This port is dependency injection for deterministic tests, never a tool. */
export interface EngineRequest { request: BrowserRequest; main: boolean; document: boolean; attributable: boolean; cookies: string; send(response: BrokerResponse): Promise<void>; deny(): Promise<void> }
/** Trusted finite engine operations; raw page, protocol and cookie handles never leave this module. */
export interface BrowserEngine {
  navigate(url: string): Promise<void>; read(generation: number): Promise<BrowserObservation>; image(): Promise<Uint8Array>;
  interact(kind: 'click' | 'submit' | 'type' | 'select', target: string, value?: string, generation?: number): Promise<void>;
  ownerInput(input: OwnerBrowserInput): Promise<void>; cookie(name: string, url: string): Promise<string | null>;
  close(): Promise<void>;
}
/** Protected constructor parameters, including an always-on callback for all intercepted HTTP requests. */
export interface EngineOptions { profilePath: string; executablePath: string; mode: BrowserMode; request(input: EngineRequest): Promise<void> }
/** A browser-level deny proxy catches any traffic not handled by interception. It never opens an outbound socket. */
export async function denyProxy(): Promise<{ url: string; close(): Promise<void>; count(): number }> {
  let count = 0;
  const server: Server = createServer((_req, res) => { count++; res.writeHead(403); res.end(); });
  server.on('connect', (_req, socket) => { count++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new BrowserError('engine_unavailable');
  return { url: `http://127.0.0.1:${address.port}`, count: () => count, close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(e => e && (e as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(e) : resolve()); }) };
}
/** Chromium runs in the protected host, with a pipe-only control channel and no direct network route.
 * HTTP goes through route interception -> host policy broker -> fulfill. Missing interception reaches
 * a deny-only proxy; QUIC, WebRTC UDP, DNS, workers, downloads and extensions are disabled.
 * This protects against page behavior, not a browser-engine/host compromise.
 */
export async function launchProtectedEngine(options: EngineOptions): Promise<BrowserEngine> {
  await mkdir(options.profilePath, { recursive: true, mode: 0o700 });
  if (await realpath(options.profilePath) !== options.profilePath) throw new BrowserError('profile_path_unsupported');
  await chmod(options.profilePath, 0o700);
  const proxy = await denyProxy();
  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(options.profilePath, {
      executablePath: options.executablePath, headless: true, javaScriptEnabled: options.mode === 'general',
      serviceWorkers: 'block', acceptDownloads: false, viewport: { width: 1280, height: 800 },
      proxy: { server: proxy.url, bypass: '<-loopback>' },
      args: ['--disable-quic', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update', '--disable-domain-reliability', '--disable-features=WebTransport,MediaRouter,DnsOverHttps,Prerender2,SpeculationRules', '--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
  } catch { await proxy.close(); throw new BrowserError('engine_unavailable'); }
  context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(30000);
  const page = context.pages()[0] ?? await context.newPage();
  let expected: { method: string; url: string; bodyBase64: string } | null = null;
  const targets = new Map<string, { handle: ElementHandle<HTMLElement | SVGElement>; generation: number }>(); let serial = 0;
  const safeHeaders = (response: BrokerResponse): Record<string, string> => ({
    ...response.headers, 'referrer-policy': 'no-referrer', 'x-dns-prefetch-control': 'off', 'x-content-type-options': 'nosniff', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=()',
    'content-security-policy': options.mode === 'static'
      ? "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; sandbox allow-forms allow-same-origin"
      : "object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action http: https:; sandbox allow-scripts allow-forms allow-same-origin",
  });
  context.on('page', popup => { if (popup !== page) void popup.close(); });
  await context.routeWebSocket('**/*', socket => socket.close({ code: 1008, reason: 'protocol_unsupported' }));
  await context.route('**/*', async (route: Route) => {
    const req = route.request();
    try {
      const frame = req.frame();
      if (frame.page() !== page || frame !== page.mainFrame() || !/^https?:/.test(req.url())) { await route.abort(); return; }
      const headers = await req.allHeaders();
      const body = req.postDataBuffer();
      if (headers['content-length'] && Number(headers['content-length']) > (body?.length ?? 0)) { await route.abort(); return; }
      const actual = { method: req.method(), url: req.url(), bodyBase64: body?.toString('base64') ?? '' };
      const attributable = req.isNavigationRequest() && expected !== null && actual.method === expected.method && actual.url === expected.url && actual.bodyBase64 === expected.bodyBase64;
      if (attributable) expected = null;
      await options.request({
        request: { method: req.method(), url: req.url(), contentType: headers['content-type'] ?? '', bodyBase64: body?.toString('base64') ?? '', navigation: req.isNavigationRequest() },
        main: true, document: req.resourceType() === 'document', attributable, cookies: headers.cookie ?? '',
        send: async response => {
          const loaded = req.isNavigationRequest() ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {}) : null;
          await route.fulfill({ status: response.status, headers: safeHeaders(response), body: Buffer.from(response.body) });
          if (loaded) await loaded;
        },
        deny: () => route.abort('blockedbyclient'),
      });
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  });
  page.on('download', download => { void download.cancel(); });
  const get = (id: string, expected: number): ElementHandle<HTMLElement | SVGElement> => { const target = targets.get(id); if (!target || target.generation !== expected) throw new BrowserError('stale_target'); return target.handle; };
  const expectNative = async (el: ElementHandle<HTMLElement | SVGElement>): Promise<void> => {
    expected = null;
    const next = await el.evaluate(element => {
      const link = element.closest('a[href]');
      if (link instanceof HTMLAnchorElement) return { method: 'GET', url: link.href, body: '' };
      if (!(element instanceof HTMLButtonElement || element instanceof HTMLInputElement) || !element.form) return null;
      if (element.type !== 'submit' && element.type !== 'image') return null;
      const form = element.form, method = (element.getAttribute('formmethod') ?? form.method).toUpperCase();
      const url = new URL(element.getAttribute('formaction') ?? form.action, location.href);
      if (!['GET', 'POST'].includes(method) || form.enctype !== 'application/x-www-form-urlencoded') return null;
      const data = new FormData(form, element), fields = new URLSearchParams();
      for (const [key, value] of data) { if (typeof value !== 'string') return null; fields.append(key, value); }
      if (method === 'GET') { url.search = fields.toString(); return { method, url: url.href, body: '' }; }
      return { method, url: url.href, body: fields.toString() };
    });
    if (next) expected = { method: next.method, url: next.url, bodyBase64: Buffer.from(next.body).toString('base64') };
  };
  return {
    async navigate(url) { targets.clear(); expected = { method: 'GET', url: new URL(url).href, bodyBase64: '' }; await page.goto(url, { waitUntil: 'networkidle' }); },
    async read(generation) {
      targets.clear(); const n = ++serial;
      // Fixed protected capture code, never agent-provided JS. Input values, hidden DOM and scripts are absent.
      if (await page.locator('input[type=password],input[autocomplete=one-time-code],input[type=file]').count()) throw new BrowserError('secret_boundary');
      const text = await page.locator('body').innerText(); const bytes = Buffer.from(text);
      const elements: BrowserObservation['elements'] = [];
      const all = page.locator('a[href],button,input:not([type=hidden]),textarea,select');
      for (let i = 0, count = Math.min(await all.count(), 64); i < count; i++) {
        const el = all.nth(i); if (!await el.isVisible()) continue;
        const tag = await el.evaluate(e => e.tagName.toLowerCase());
        const type = await el.getAttribute('type') ?? '';
        const name = await el.getAttribute('aria-label') ?? await el.getAttribute('name') ?? (tag === 'input' ? '' : (await el.innerText()).slice(0, 200));
        const id = `e${n}_${i}`; const handle = await el.elementHandle(); if (!handle) continue; targets.set(id, { handle, generation }); elements.push({ id, tag, name, type });
      }
      return { id: `observation_${n}`, generation, url: page.url(), text: bytes.subarray(0, 32768).toString('utf8'), truncated: bytes.length > 32768, elements };
    },
    async image() { return page.screenshot({ type: 'png', timeout: 5000 }); },
    async interact(kind, id, value, targetGeneration) {
      expected = null;
      const el = get(id, targetGeneration ?? -1); if (!await el.evaluate(e => e.isConnected)) throw new BrowserError('stale_target');
      const type = (await el.getAttribute('type') ?? '').toLowerCase();
      if (['password', 'file', 'hidden'].includes(type) || await el.getAttribute('autocomplete') === 'one-time-code') throw new BrowserError('secret_boundary');
      if (kind === 'click' || kind === 'submit') {
        const href = await el.getAttribute('href');
        if ((href && !/^https?:/.test(new URL(href, page.url()).href)) || (await el.getAttribute('target') ?? '_self') !== '_self' || await el.getAttribute('download') !== null) throw new BrowserError('effect_unsupported');
        if (kind === 'submit' && !['button', 'input'].includes(await el.evaluate(e => e.tagName.toLowerCase()))) throw new BrowserError('effect_unsupported');
        await expectNative(el); await el.click({ noWaitAfter: true });
      } else if (kind === 'type') { if (/[\r\n]/.test(value ?? '')) throw new BrowserError('effect_unsupported'); await el.fill(value ?? ''); }
      else await el.selectOption(value ?? '');
    },
    async ownerInput(input) {
      expected = null;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.field)) throw new BrowserError('invalid_operation');
      const el = page.locator(`[name="${input.field}"]`);
      if (input.kind === 'type') { if (!input.value || input.value.length > 2000 || input.value.includes('\0')) throw new BrowserError('invalid_operation'); await el.fill(input.value); }
      else { const handle = await el.elementHandle(); if (!handle) throw new BrowserError('stale_target'); await expectNative(handle); await el.click({ noWaitAfter: true }); }
    },
    async cookie(name, url) { const cookie = (await context.cookies(url)).find(c => c.name === name && c.httpOnly); return cookie ? `${cookie.name}=${cookie.value}` : null; },
    async close() { try { await context.close(); } finally { await proxy.close(); } },
  };
}
