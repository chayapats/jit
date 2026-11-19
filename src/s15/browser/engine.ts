import { chromium, type BrowserContext, type Page, type Route, type ElementHandle } from 'playwright-core';
import { chmod, mkdir, realpath } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import type { BrokerResponse, BrowserInputSnapshot, BrowserMode, BrowserObservation, BrowserOwnerControl, BrowserRequest, OwnerBrowserInput } from './types';
import { BrowserError } from './validation';

/** Private host request interception. This port is dependency injection for deterministic tests, never a tool. */
export interface EngineRequest { request: BrowserRequest; main: boolean; document: boolean; attributable: boolean; intent?: string; cookies: string; send(response: BrokerResponse): Promise<void>; deny(): Promise<void> }
/** Ephemeral host binding. Only its exact actual request may carry the nonce; settlement never reconstructs input. */
export interface EngineIntent { nonce: string; request: Readonly<BrowserRequest>; settled: Promise<string | null> }
/** Final input fence: engines recheck after every readiness wait and immediately before each protocol send. */
export interface EngineInputContext { signal: AbortSignal; generation?: number; guard(): void; prepareIntent?(input: BrowserInputSnapshot): EngineIntent | null }
/** Trusted finite engine operations; raw page, protocol and cookie handles never leave this module. */
export interface BrowserEngine {
  navigate(url: string, input: EngineInputContext): Promise<void>; read(generation: number): Promise<BrowserObservation>; image(context?: { agent: true }): Promise<Uint8Array>;
  /** Actual document URL before guarded capture; legacy injected engines retain strict post-capture URL checks. */
  location?(): Promise<string>;
  /** Transient owner-only controls, with no entered values and no raw selector API. */
  ownerControls?(generation: number): Promise<BrowserOwnerControl[]>;
  interact(kind: 'click' | 'submit' | 'type' | 'select', target: string, value: string | undefined, generation: number | undefined, input: EngineInputContext): Promise<void>;
  ownerInput(input: OwnerBrowserInput, context: EngineInputContext): Promise<void>; cookie(name: string, url: string): Promise<string | null>;
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
/**
 * Chromium switches that leave the deny-only proxy as its only network path (BROW15-03 asserts each one): no QUIC or
 * HTTP/3, no WebTransport, no name resolution at all (every host maps to NOTFOUND, so neither the built-in async
 * resolver nor DNS-over-HTTPS can run), no non-proxied WebRTC UDP, and no background, sync, component-update,
 * domain-reliability, prerender or speculative traffic. The proxy itself has no bypass list, loopback included.
 */
export const protectedEngineArgs: readonly string[] = Object.freeze(['--disable-quic', '--disable-background-networking', '--disable-extensions', '--disable-sync', '--disable-component-update', '--disable-domain-reliability', '--disable-features=WebTransport,MediaRouter,DnsOverHttps,AsyncDns,Prerender2,SpeculationRules', '--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']);
/** Chromium's proxy settings: the deny-only listener for every scheme; `<-loopback>` removes the implicit loopback bypass. */
export const protectedEngineProxy = (server: string): { server: string; bypass: string } => ({ server, bypass: '<-loopback>' });
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
      proxy: protectedEngineProxy(proxy.url),
      args: [...protectedEngineArgs],
    });
  } catch { await proxy.close(); throw new BrowserError('engine_unavailable'); }
  context.setDefaultTimeout(5000); context.setDefaultNavigationTimeout(30000);
  const page = context.pages()[0] ?? await context.newPage();
  let expected: { method: string; url: string; bodyBase64: string } | null = null;
  let expectedIntent: EngineIntent | null = null;
  const targets = new Map<string, { handle: ElementHandle<HTMLElement | SVGElement>; generation: number; url: string }>(); let serial = 0;
  const ownerTargets = new Map<string, { handle: ElementHandle<HTMLElement | SVGElement>; generation: number; url: string }>();
  const safeHeaders = (response: BrokerResponse): Record<string, string> => ({
    ...response.headers, ...(response.setCookies.length ? { 'set-cookie': response.setCookies.join('\n') } : {}), 'referrer-policy': 'no-referrer', 'x-dns-prefetch-control': 'off', 'x-content-type-options': 'nosniff', 'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=()',
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
      const request: BrowserRequest = { ...actual, contentType: headers['content-type'] ?? '', navigation: req.isNavigationRequest() };
      const intent = expectedIntent && Object.entries(expectedIntent.request).every(([key, value]) => request[key as keyof BrowserRequest] === value) ? expectedIntent.nonce : null;
      if (intent) expectedIntent = null;
      await options.request({
        request,
        main: true, document: req.resourceType() === 'document', attributable, ...(intent ? { intent } : {}), cookies: headers.cookie ?? '',
        send: async response => {
          const loaded = req.isNavigationRequest() ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 5000 }) : null;
          if (loaded) void loaded.catch(() => {});
          await route.fulfill({ status: response.status, headers: safeHeaders(response), body: Buffer.from(response.body) });
          if (loaded) await loaded;
        },
        deny: () => route.abort('blockedbyclient'),
      });
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  });
  page.on('download', download => { void download.cancel(); });
  const get = (id: string, expected: number): ElementHandle<HTMLElement | SVGElement> => { const target = targets.get(id); if (!target || target.generation !== expected || target.url !== page.url()) throw new BrowserError('stale_target'); return target.handle; };
  const expectNative = async (el: ElementHandle<HTMLElement | SVGElement>): Promise<boolean> => {
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
    return next !== null;
  };
  const session = await context.newCDPSession(page);
  await session.send('Page.enable');
  const mainFrame = (await session.send('Page.getFrameTree')).frameTree.frame.id;
  const navigationStopped = () => {
    let started = false, resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; });
    const start = (event: { frameId: string }) => { if (event.frameId === mainFrame) started = true; };
    const stop = (event: { frameId: string }) => { if (event.frameId === mainFrame && started) resolve(); };
    const closed = () => resolve();
    session.on('Page.frameStartedLoading', start); session.on('Page.frameStoppedLoading', stop);
    page.on('close', closed);
    return { promise, started: () => started, close() { session.off('Page.frameStartedLoading', start); session.off('Page.frameStoppedLoading', stop); page.off('close', closed); } };
  };
  const checked = async <T>(promise: Promise<T>, input: EngineInputContext): Promise<T> => {
    input.guard();
    // The gateway returns its fenced result immediately, but retains the input lease until this actual
    // browser operation settles. An abort race alone would let an old error document interrupt the next
    // navigation after takeover. Browser cancellation is not settlement of a separate broker effect.
    const result = await promise; input.guard(); return result;
  };
  const prepare = async (el: ElementHandle<HTMLElement | SVGElement>, kind: BrowserInputSnapshot['kind'], value: string | undefined, input: EngineInputContext): Promise<EngineIntent | null> => {
    if (!input.prepareIntent) return null;
    const snapshot = await checked(el.evaluate((element, operation) => {
      if (!element.isConnected) throw Error('stale_target');
      const form = element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement ? element.form : element.closest('form');
      const fields: BrowserInputSnapshot['fields'] = []; let bytes = 0;
      const controls = form ? Array.from(form.elements) : Array.from(document.querySelectorAll('input,textarea,select'));
      for (const field of controls) {
        if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) || field.disabled || !field.getClientRects().length || getComputedStyle(field).visibility !== 'visible') continue;
        const type = field instanceof HTMLInputElement ? field.type.toLowerCase() : field instanceof HTMLSelectElement ? field.multiple ? 'select-multiple' : 'select-one' : 'textarea';
        const autocomplete = (field.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/);
        const name = field.name;
        if (!name || ['password', 'file', 'hidden', 'submit', 'image', 'button', 'reset'].includes(type) || autocomplete.some(token => ['username', 'current-password', 'new-password', 'one-time-code'].includes(token) || token.startsWith('cc-'))) continue;
        const values = field instanceof HTMLSelectElement ? Array.from(field.selectedOptions, option => option.value) : field instanceof HTMLInputElement && ['checkbox', 'radio'].includes(type) && !field.checked ? [] : [field.value];
        bytes += name.length + values.reduce((n, item) => n + item.length, 0);
        if (fields.length >= 64 || name.length > 1024 || values.length > 64 || values.some(item => item.length > 4096) || bytes > 32768) throw Error('input_limit');
        fields.push({ name, type, values });
      }
      const target = { tag: element.tagName.toLowerCase(), type: element.getAttribute('type') ?? '', name: element.getAttribute('name') ?? '' };
      if (location.href.length > 4096 || target.type.length > 64 || target.name.length > 1024) throw Error('input_limit');
      return { url: location.href, ...operation, target, fields };
    }, { kind, value: value ?? null }), input);
    const intent = input.prepareIntent(snapshot); input.guard(); if (intent) expectedIntent = intent; return intent;
  };
  const finishIntent = async (intent: EngineIntent | null, input: EngineInputContext) => {
    if (!intent) return;
    const code = await checked(intent.settled, input); if (code) throw new BrowserError(code);
  };
  const click = async (el: ElementHandle<HTMLElement | SVGElement>, input: EngineInputContext, kind: 'click' | 'submit' = 'click'): Promise<void> => {
    await checked(el.waitForElementState('visible', { timeout: 5000 }), input);
    await checked(el.waitForElementState('stable', { timeout: 5000 }), input);
    await checked(el.waitForElementState('enabled', { timeout: 5000 }), input);
    await checked(el.scrollIntoViewIfNeeded({ timeout: 5000 }), input);
    const box = await checked(el.boundingBox(), input); if (!box) throw new BrowserError('stale_target');
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const hits = await checked(el.evaluate((e, p) => { const hit = document.elementFromPoint(p.x, p.y); return hit === e || !!hit && e.contains(hit); }, { x, y }), input);
    if (!hits) throw new BrowserError('stale_target');
    const navigates = await checked(expectNative(el), input);
    const intent = await prepare(el, kind, undefined, input);
    const stopped = navigates || intent ? navigationStopped() : null;
    const navigation = navigates ? page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30000 }).then(() => null, (error: unknown) => error) : null;
    const settled = navigation?.then(async error => { if (stopped?.started()) await stopped.promise; return error; });
    let issued = false;
    try {
      input.guard(); issued = true; const down = session.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, x, y, clickCount: 1 });
      // Both halves are enqueued in the same synchronous turn; cancellation cannot leave a queued half-click.
      input.guard(); const up = session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, x, y, clickCount: 1 });
      await Promise.all([down, up]); input.guard();
      await finishIntent(intent, input);
      if (settled) {
        // A denied navigation can still commit Chromium's error document after waitForNavigation rejects.
        // Wait for the frame's real stop event before another input can replace it.
        const error = await checked(settled, input);
        if (error) throw new BrowserError('navigation_failed');
      }
    } finally { try { if (issued && settled) await settled; else if (issued && stopped?.started()) await stopped.promise; } finally { if (expectedIntent === intent) expectedIntent = null; stopped?.close(); } }
  };
  const fill = async (el: ElementHandle<HTMLElement | SVGElement>, value: string, input: EngineInputContext): Promise<void> => {
    await checked(el.waitForElementState('editable', { timeout: 5000 }), input);
    input.guard();
    await el.evaluate((e, text) => {
      if (!(e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement)) throw new Error('invalid_field');
      const prototype = e instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(e, text);
      e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    }, value); input.guard();
  };
  return {
    async navigate(url, input) {
      targets.clear(); expectedIntent = null; expected = { method: 'GET', url: new URL(url).href, bodyBase64: '' }; input.guard();
      // Match native navigation's readiness barrier so initial JS reads stay inside the bounded scope.
      // Quiescence acknowledges navigation; exact request guards still decide authority and outcomes.
      const stopped = navigationStopped();
      try { await checked(page.goto(url, { waitUntil: options.mode === 'general' ? 'networkidle' : 'domcontentloaded' }), input); }
      catch (error) { if (stopped.started()) await stopped.promise; throw error; }
      finally { stopped.close(); }
    },
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
        const id = `e${n}_${i}`; const handle = await el.elementHandle(); if (!handle) continue; targets.set(id, { handle, generation, url: page.url() }); elements.push({ id, tag, name, type });
      }
      return { id: `observation_${n}`, generation, url: page.url(), text: bytes.subarray(0, 32768).toString('utf8'), truncated: bytes.length > 32768, elements };
    },
    async location() { return page.evaluate(() => location.href); },
    async ownerControls(generation) {
      ownerTargets.clear(); const n = ++serial, url = page.url(), result: BrowserOwnerControl[] = [];
      const all = page.locator('input:not([type=hidden]):not([type=file]),textarea,button');
      for (let i = 0, count = Math.min(await all.count(), 32); i < count; i++) {
        const el = all.nth(i); if (!await el.isVisible() || !await el.isEnabled()) continue;
        const data = await el.evaluate(element => {
          const button = element instanceof HTMLButtonElement || element instanceof HTMLInputElement && ['submit', 'button'].includes(element.type);
          const label = element.getAttribute('aria-label') || ('labels' in element ? Array.from((element as HTMLInputElement).labels ?? []).map(label => label.textContent).join(' ') : '') || (button ? element.textContent : element.getAttribute('placeholder')) || element.getAttribute('name') || 'Field';
          return { kind: button ? 'button' as const : element.getAttribute('type') === 'password' || element.getAttribute('autocomplete') === 'one-time-code' ? 'password' as const : 'text' as const, label: label.trim().slice(0, 160) };
        });
        const handle = await el.elementHandle(); if (!handle) continue;
        const id = `o${n}_${i}`; ownerTargets.set(id, { handle, generation, url }); result.push({ id, ...data });
      }
      if (url !== page.url()) { ownerTargets.clear(); throw new BrowserError('stale_target'); } return result;
    },
    async image(control) {
      const url = page.url(), secret = () => page.locator('input[type=password],input[autocomplete=one-time-code],input[type=file]').count();
      if (control?.agent && await secret()) throw new BrowserError('secret_boundary');
      const bytes = await page.screenshot({ type: 'png', timeout: 5000 });
      if (control?.agent && (url !== page.url() || await secret())) throw new BrowserError('secret_boundary'); return bytes;
    },
    async interact(kind, id, value, targetGeneration, input) {
      expected = null; expectedIntent = null;
      const el = get(id, targetGeneration ?? -1); if (!await el.evaluate(e => e.isConnected)) throw new BrowserError('stale_target');
      const type = (await el.getAttribute('type') ?? '').toLowerCase();
      if (['password', 'file', 'hidden'].includes(type) || await el.getAttribute('autocomplete') === 'one-time-code') throw new BrowserError('secret_boundary');
      if (kind === 'click' || kind === 'submit') {
        const href = await el.getAttribute('href');
        if ((href && !/^https?:/.test(new URL(href, page.url()).href)) || (await el.getAttribute('target') ?? '_self') !== '_self' || await el.getAttribute('download') !== null) throw new BrowserError('effect_unsupported');
        if (kind === 'submit' && !['button', 'input'].includes(await el.evaluate(e => e.tagName.toLowerCase()))) throw new BrowserError('effect_unsupported');
        await click(el, input, kind);
      } else if (kind === 'type') {
        if (/[\r\n]/.test(value ?? '')) throw new BrowserError('effect_unsupported'); const intent = await prepare(el, kind, value, input);
        try { await fill(el, value ?? '', input); await finishIntent(intent, input); } finally { if (expectedIntent === intent) expectedIntent = null; }
      }
      else {
        await checked(el.waitForElementState('enabled', { timeout: 5000 }), input); const intent = await prepare(el, kind, value, input); input.guard();
        try { await el.evaluate((e, v) => { if (!(e instanceof HTMLSelectElement)) throw new Error('invalid_field'); e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, value ?? ''); input.guard(); await finishIntent(intent, input); }
        finally { if (expectedIntent === intent) expectedIntent = null; }
      }
    },
    async ownerInput(input, control) {
      expected = null; expectedIntent = null;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(input.field)) throw new BrowserError('invalid_operation');
      const target = ownerTargets.get(input.field);
      if (/^o[0-9]+_[0-9]+$/.test(input.field) && (!target || target.url !== page.url() || target.generation !== control.generation)) throw new BrowserError('stale_target');
      const el = target?.handle ?? await checked(page.locator(`[name="${input.field}"]`).elementHandle(), control); if (!el) throw new BrowserError('stale_target');
      if (input.kind === 'type') { if (!input.value || input.value.length > 2000 || input.value.includes('\0')) throw new BrowserError('invalid_operation'); await fill(el, input.value, control); }
      else await click(el, control);
    },
    async cookie(name, url) { const cookie = (await context.cookies(url)).find(c => c.name === name && c.httpOnly); return cookie ? (await context.cookies(url)).filter(c => c.httpOnly).map(c => `${c.name}=${c.value}`).join('; ') : null; },
    async close() { try { await context.close(); } finally { await proxy.close(); } },
  };
}
