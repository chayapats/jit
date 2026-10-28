import { afterEach, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { colorTokens } from "../src/web-design";
import { assetUrl, lookupAsset, staticAssets } from "../src/web-assets";
import { drawIcon, iconSpecs, pathPolygons } from "../src/web-icons";
import { offlineAssets, offlineVersion, serviceWorkerPath, serviceWorkerScript } from "../src/web-pwa";
import { contentSecurityPolicy } from "../src/web";
import { accessibilityProblems } from "./fixtures/a11y";
import { ux03Installation } from "./fixtures/ux03";

/**
 * UX03 (S09-D13, S09-AC07/AC08, ADR 0028): the static-only PWA (web.pwa/v1), the mobile layout at 360–430 px and
 * deterministic accessibility checks of the server-rendered HTML in both languages and both themes. No browser, no
 * network: the service worker runs against fake `caches`/`fetch` globals that call the real web handler, the
 * responsive snapshot evaluates the generated stylesheet's media queries per viewport width, and the accessibility
 * checks parse every main page as served.
 */
const installations: Awaited<ReturnType<typeof ux03Installation>>[] = [];
afterEach(async () => { for (const f of installations.splice(0)) await f.close(); });
async function installation() {
  const f = await ux03Installation();
  installations.push(f);
  return f;
}
type Installation = Awaited<ReturnType<typeof installation>>;
const get = (f: Installation, path: string, headers: Record<string, string> = {}, signedIn = true) =>
  f.web(new Request(`${f.config.origin}${path}`, { headers: { ...(signedIn ? { cookie: `jit_session=${f.token}` } : {}), ...headers } }));
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const setPreferences = (f: Installation, theme: "dark" | "light", language: "th" | "en") => {
  const { revision } = f.app.preferences(f.auth.actor);
  f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: crypto.randomUUID(), projectId: null, expectedRevision: revision, payload: { theme, language } });
};

// ---------------------------------------------------------------------------------------------------------------
// web.pwa/v1: manifest, icons and head tags

test("web.pwa/v1 manifest: standalone, scoped to the origin, hashed icons that are table entries, no remote origin", () => {
  const manifest = JSON.parse(decode(staticAssets.get("manifest.webmanifest")!.body));
  expect(staticAssets.get("manifest.webmanifest")!.contentType).toBe("application/manifest+json");
  expect(manifest).toEqual({
    id: "/", name: "Jit", short_name: "Jit", start_url: "/", scope: "/", display: "standalone",
    background_color: colorTokens.dark.bg, theme_color: colorTokens.dark.bg,
    icons: [
      { src: assetUrl("icon-192.png"), sizes: "192x192", type: "image/png", purpose: "any" },
      { src: assetUrl("icon-512.png"), sizes: "512x512", type: "image/png", purpose: "any" },
      { src: assetUrl("icon-maskable-512.png"), sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  });
  for (const icon of manifest.icons) expect(lookupAsset(icon.src)?.contentType).toBe("image/png");
});

/** Decodes the shipped 8-bit RGBA PNGs (filter type 0 on every row, as src/web-icons.ts writes them). */
function decodePng(bytes: Uint8Array): { width: number; height: number; pixels: Uint8Array } {
  expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8, width = 0, height = 0;
  const data: Uint8Array[] = [];
  while (offset < bytes.length) {
    const length = view.getUint32(offset), type = decode(bytes.slice(offset + 4, offset + 8)), body = bytes.slice(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); expect([...body.slice(8)]).toEqual([8, 6, 0, 0, 0]); }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data)), stride = width * 4 + 1, pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    expect(raw[y * stride]).toBe(0);
    pixels.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
  }
  return { width, height, pixels };
}

test("install icons are the logo drawing: shipped PNGs match a fresh rasterization of the favicon geometry", () => {
  for (const spec of iconSpecs) {
    const shipped = decodePng(staticAssets.get(spec.file as "icon-192.png")!.body);
    expect([shipped.width, shipped.height]).toEqual([spec.size, spec.size]);
    const fresh = drawIcon(spec);
    // Floating-point trigonometry may differ by an ulp between engines; one step per channel is the tolerance.
    let off = 0;
    for (let i = 0; i < fresh.length; i++) if (Math.abs(fresh[i]! - shipped.pixels[i]!) > 1) off++;
    expect(off).toBe(0);
    const at = (x: number, y: number) => [...shipped.pixels.subarray((y * spec.size + x) * 4, (y * spec.size + x) * 4 + 4)];
    const dark = [10, 10, 10, 255], light = [237, 237, 237, 255];
    // `any` keeps the favicon's rounded corners transparent; maskable and touch icons are full-bleed tiles.
    expect(at(0, 0)).toEqual(spec.purpose === "any" ? [0, 0, 0, 0] : dark);
    expect(at(Math.floor(spec.size / 2), Math.floor(spec.size * .04))).toEqual(dark);
    // The head sits on the centre line, the dot above it, and the body near the base.
    expect(at(Math.floor(spec.size / 2), Math.floor(spec.size * .38))).toEqual(light);
    expect(at(Math.floor(spec.size / 2), Math.floor(spec.size * (spec.purpose === "maskable" ? .72 : .8)))).toEqual(light);
  }
  // Maskable: everything drawn in the figure colour stays inside the central 80 % safe circle.
  const mask = drawIcon({ size: 512, purpose: "maskable" });
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    if (mask[(y * 512 + x) * 4]! > 10 && Math.hypot(x + .5 - 256, y + .5 - 256) > 512 * .4) throw new Error(`maskable figure outside the safe zone at ${x},${y}`);
  }
});

test("the icon path parser reads the SVG number grammar exactly and drops degenerate arcs", () => {
  const first = (d: string) => pathPolygons(d)[0]![0];
  expect(first("M1e1 2E1L30 0L30 30Z")).toEqual([10, 20]);
  expect(first("M+1.5-2.5e-1L3 3L4 0Z")).toEqual([1.5, -0.25]);
  expect(first("M.5.5L3 3L4 0Z")).toEqual([.5, .5]);
  for (const d of ["M1e L2 2 L3 0 Z", "M1 L2 2", "1 2 L3 3", "M1 2 X3 4"]) expect(() => pathPolygons(d)).toThrow();
  const arc = pathPolygons("M0 0 A5 5 0 0 1 0 0 L1 0 L1 1 Z")[0]!;
  expect(arc).toEqual([[0, 0], [1, 0], [1, 1]]);
  expect(arc.flat().every(Number.isFinite)).toBe(true);
  // A zero radius is a straight line to the end point.
  expect(pathPolygons("M0 0 A0 5 0 0 1 4 0 L4 4 Z")[0]).toEqual([[0, 0], [4, 0], [4, 4]]);
  // A half circle reaches its far point and ends exactly on the end point.
  const half = pathPolygons("M0 0 A1 1 0 0 1 2 0 Z")[0]!;
  expect(half.at(-1)).toEqual([2, 0]);
  expect(Math.min(...half.map(([, y]) => y))).toBeCloseTo(-1, 6);
});

test("every page links the manifest, the touch icon and a theme colour, allows zoom and covers the safe areas", async () => {
  const f = await installation();
  for (const [theme, language] of [["dark", "th"], ["light", "en"]] as const) {
    setPreferences(f, theme, language);
    for (const route of ["/", f.routes[4]!, "/settings"]) {
      const html = await (await get(f, route)).text();
      expect(html).toContain(`<link rel="manifest" href="${assetUrl("manifest.webmanifest")}">`);
      expect(html).toContain(`<link rel="apple-touch-icon" href="${assetUrl("apple-touch-icon.png")}">`);
      expect(html).toContain(`<meta name="theme-color" content="${colorTokens[theme].bg}">`);
      expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">');
    }
  }
  const login = await (await get(f, "/login", {}, false)).text();
  expect(login).toContain(`<meta name="theme-color" content="${colorTokens.dark.bg}" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="${colorTokens.light.bg}" media="(prefers-color-scheme: light)">`);
  expect(login).toContain(`<link rel="manifest" href="${assetUrl("manifest.webmanifest")}">`);
  expect(login).not.toMatch(/user-scalable|maximum-scale/);
});

// ---------------------------------------------------------------------------------------------------------------
// web.pwa/v1: the service worker and its cache allowlist

test("the service worker is public, never stored, carries the CSP and lists exactly the static allowlist", async () => {
  const f = await installation();
  const response = await get(f, serviceWorkerPath, {}, false);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
  const body = await response.text();
  expect(body).toBe(serviceWorkerScript());
  // Only stylesheet, scripts, fonts and icons: never the manifest, licences, pages or anything outside the table.
  expect(offlineAssets.map(asset => asset.name).sort()).toEqual(["app.css", "app.js", "apple-touch-icon.png", "favicon.svg", "icon-192.png", "icon-512.png",
    "icon-maskable-512.png", "inter.woff2", "jetbrains-mono.woff2", "noto-sans-thai.woff2"]);
  for (const asset of offlineAssets) expect(lookupAsset(asset.path)).toBe(asset);
  expect(body).toContain(`const table = ${JSON.stringify({ version: offlineVersion, paths: offlineAssets.map(asset => asset.path) })};`);
  // No background sync, push, periodic work, storage of its own, or remote origin.
  const code = body.replace(/^\s*\/\/.*$/gm, "");
  expect(code).not.toMatch(/\bsync\b|periodicsync|\bpush\b|indexedDB|localStorage|importScripts|https?:\/\/|eval\(|new Function/);
  expect([...code.matchAll(/addEventListener\("([a-z]+)"/g)].map(m => m[1])).toEqual(["install", "activate", "fetch"]);
  // app.js registers it at the origin scope, bypassing the HTTP cache, only in a secure context.
  const js = decode(staticAssets.get("app.js")!.body);
  expect(js).toContain('navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })');
  expect(js).toContain("globalThis.isSecureContext");
});

/** Runs the served worker against fake `caches`/`fetch` globals; network requests go to the real web handler. */
function runWorker(f: Installation, body: string, caches: Map<string, Map<string, Response>>, options: { put?: (key: string) => Promise<void> } = {}) {
  const listeners: Record<string, (event: unknown) => void> = {};
  const network: string[] = [];
  const fetchImpl = async (input: Request | string) => {
    const request = typeof input === "string" ? new Request(new URL(input, f.config.origin)) : input;
    network.push(new URL(request.url).pathname + new URL(request.url).search);
    const response = await f.web(new Request(request.url, { method: request.method, headers: { cookie: `jit_session=${f.token}` } }));
    // A same-origin network answer in a browser is a "basic" response.
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const fakeCaches = {
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new Map());
      const cache = caches.get(name)!;
      return {
        addAll: async (paths: string[]) => { for (const path of paths) { const r = await fetchImpl(path); if (r.status !== 200) throw new Error(`addAll ${path} ${r.status}`); cache.set(path, r); } },
        match: async (key: string) => cache.get(key)?.clone(),
        // Like the real Cache API, the entry exists only once the (possibly slow or failing) write settles.
        put: async (key: string, response: Response) => { await options.put?.(key); cache.set(key, response); },
      };
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; },
    location: { origin: f.config.origin }, skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  new Function("self", "caches", "fetch", body)(self, fakeCaches, fetchImpl);
  const lifecycle = async (type: "install" | "activate") => {
    let wait: Promise<unknown> = Promise.resolve();
    listeners[type]!({ waitUntil: (promise: Promise<unknown>) => { wait = promise; } });
    await wait;
  };
  /** Dispatches one fetch event; returns the worker's answer, or null when it left the request to the network. */
  /** Lifetime extensions the worker registered with `event.waitUntil` during fetch events. */
  const extended: Promise<unknown>[] = [];
  const request = async (url: string, init: RequestInit = {}): Promise<Response | null> => {
    let answer = null as Promise<Response> | null;
    listeners.fetch!({ request: new Request(new URL(url, f.config.origin), init), respondWith: (promise: Promise<Response>) => { answer = promise; },
      waitUntil: (promise: Promise<unknown>) => { extended.push(promise); } });
    return answer ? await answer : null;
  };
  return { lifecycle, request, network, listeners, extended };
}

test("service worker cache holds only the asset table allowlist; pages, API, SSE, auth and other assets are never answered or stored", async () => {
  const f = await installation();
  const caches = new Map<string, Map<string, Response>>();
  const worker = runWorker(f, serviceWorkerScript(), caches);
  expect(Object.keys(worker.listeners).sort()).toEqual(["activate", "fetch", "install"]);
  await worker.lifecycle("install");
  await worker.lifecycle("activate");
  const name = `jit-static-${offlineVersion}`;
  expect([...caches.keys()]).toEqual([name]);
  expect([...caches.get(name)!.keys()].sort()).toEqual(offlineAssets.map(asset => asset.path).sort());

  // Browse every main page through the worker, including every URL it references, as a signed-in browser would.
  const html: string[] = [];
  for (const route of f.routes) {
    expect(await worker.request(route)).toBeNull();
    html.push(await (await get(f, route)).text());
  }
  const referenced = new Set(html.flatMap(page => [...page.matchAll(/(?:href|src|action)="(\/[^"#]*)/g)].map(m => m[1]!.replaceAll("&amp;", "&"))));
  expect(referenced.size).toBeGreaterThan(40);
  for (const path of referenced) {
    const answer = await worker.request(path);
    if (offlineAssets.some(asset => asset.path === path)) {
      expect(answer?.status).toBe(200);
      expect(new Uint8Array(await answer!.arrayBuffer())).toEqual(lookupAsset(path)!.body);
    } else expect(answer).toBeNull();
  }
  const topic = f.routes[4]!;
  const stream = `${topic}/events?cursor=0`;
  for (const path of ["/", "/login", "/logout", "/setup", "/api/projects", "/api/search?q=x", stream, `${topic}/panel`, serviceWorkerPath, assetUrl("manifest.webmanifest"),
    assetUrl("OFL-Inter.txt"), `${assetUrl("app.css")}?v=2`, "/assets/app.0000000000000000.css", `https://elsewhere.example${assetUrl("app.css")}`]) {
    expect(await worker.request(path)).toBeNull();
  }
  for (const method of ["POST", "HEAD"]) expect(await worker.request(assetUrl("app.css"), { method })).toBeNull();
  // After all of that, the cache still holds exactly the allowlist and nothing from a page or API answer.
  expect([...caches.keys()]).toEqual([name]);
  expect([...caches.get(name)!.keys()].sort()).toEqual(offlineAssets.map(asset => asset.path).sort());
  for (const response of caches.get(name)!.values()) expect(response.headers.get("content-type")).not.toMatch(/text\/html|application\/json|event-stream/);
  expect(worker.network.filter(path => !path.startsWith("/assets/"))).toEqual([]);
});

test("a cached allowlisted asset is served from cache; a miss is fetched and kept only when it is a complete 200", async () => {
  const f = await installation();
  const caches = new Map<string, Map<string, Response>>();
  const worker = runWorker(f, serviceWorkerScript(), caches);
  await worker.lifecycle("install");
  const name = `jit-static-${offlineVersion}`, css = assetUrl("app.css");
  worker.network.length = 0;
  expect((await worker.request(css))?.status).toBe(200);
  expect(worker.network).toEqual([]);
  caches.get(name)!.delete(css);
  expect((await worker.request(css))?.status).toBe(200);
  expect(worker.network).toEqual([css]);
  expect(caches.get(name)!.has(css)).toBe(true);
});

test("a cache miss's write is part of the fetch event's lifetime, and a failed write still answers from the network", async () => {
  const f = await installation();
  const caches = new Map<string, Map<string, Response>>();
  let release = () => {}, fail = false;
  const worker = runWorker(f, serviceWorkerScript(), caches, { put: () => fail ? Promise.reject(new Error("quota")) : new Promise<void>(resolve => { release = resolve; }) });
  // Install without the slow writer, then drop one entry to force a miss.
  const name = `jit-static-${offlineVersion}`, js = assetUrl("app.js");
  caches.set(name, new Map(offlineAssets.map(asset => [asset.path, new Response(asset.body)])));
  caches.get(name)!.delete(js);
  const answer = await worker.request(js);
  expect(answer?.status).toBe(200);
  expect(new Uint8Array(await answer!.arrayBuffer())).toEqual(lookupAsset(js)!.body);
  // The page has its answer while the write is still pending, and the event's lifetime waits for that write.
  expect(worker.extended).toHaveLength(1);
  expect(caches.get(name)!.has(js)).toBe(false);
  let settled = false;
  void worker.extended[0]!.then(() => { settled = true; });
  await Bun.sleep(5);
  expect(settled).toBe(false);
  release();
  await worker.extended[0];
  expect(caches.get(name)!.has(js)).toBe(true);
  // A rejected write is absorbed: the lifetime promise resolves and the response was already delivered.
  fail = true;
  caches.get(name)!.delete(js);
  expect((await worker.request(js))?.status).toBe(200);
  await expect(worker.extended[1]!).resolves.toBeUndefined();
  expect(caches.get(name)!.has(js)).toBe(false);
});

test("a new asset version opens a new cache and deletes every older cache on activation", async () => {
  const f = await installation();
  const caches = new Map<string, Map<string, Response>>([["jit-static-0000000000000000", new Map()], ["some-other-cache", new Map()]]);
  const current = runWorker(f, serviceWorkerScript(), caches);
  await current.lifecycle("install");
  // Before activation the old caches still serve the page that is open; activation clears them.
  expect(caches.size).toBe(3);
  await current.lifecycle("activate");
  expect([...caches.keys()]).toEqual([`jit-static-${offlineVersion}`]);
  // Simulate the next release: a different version and a changed asset path in the generated table line.
  const next = serviceWorkerScript().replace(`"version":"${offlineVersion}"`, `"version":"ffffffffffffffff"`).replace(`"${assetUrl("favicon.svg")}",`, "");
  expect(next).not.toBe(serviceWorkerScript());
  const upgraded = runWorker(f, next, caches);
  await upgraded.lifecycle("install");
  await upgraded.lifecycle("activate");
  expect([...caches.keys()]).toEqual(["jit-static-ffffffffffffffff"]);
  expect(caches.get("jit-static-ffffffffffffffff")!.has(assetUrl("favicon.svg"))).toBe(false);
  expect(await upgraded.request(assetUrl("favicon.svg"))).toBeNull();
  // The version follows the allowlisted bytes: it is the hash of the hashed paths.
  const { createHash } = await import("node:crypto");
  expect(offlineVersion).toBe(createHash("sha256").update(offlineAssets.map(asset => asset.path).sort().join("\n")).digest("hex").slice(0, 16));
});

// ---------------------------------------------------------------------------------------------------------------
// Responsive layout: the generated stylesheet evaluated at each viewport width

interface Rule { media: string | null; selector: string; declarations: [string, string][] }
/** Flattens the stylesheet into ordered rules with their (single-level) media condition; @font-face and @keyframes are skipped. */
function cssRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let index = 0;
  const block = (from: number) => { let depth = 0; for (let i = from; i < text.length; i++) { if (text[i] === "{") depth++; else if (text[i] === "}" && --depth === 0) return i; } throw new Error("unbalanced css"); };
  const parse = (body: string, media: string | null) => {
    for (const match of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const declarations = match[2]!.split(";").map(d => d.trim()).filter(Boolean).map(d => [d.slice(0, d.indexOf(":")).trim(), d.slice(d.indexOf(":") + 1).trim()] as [string, string]);
      for (const selector of match[1]!.split(",").map(s => s.trim()).filter(Boolean)) rules.push({ media, selector, declarations });
    }
  };
  while (index < text.length) {
    const at = text.indexOf("@", index);
    const end = at < 0 ? text.length : at;
    parse(text.slice(index, end), null);
    if (at < 0) break;
    const open = text.indexOf("{", at), close = block(open);
    const prelude = text.slice(at, open).trim();
    if (prelude.startsWith("@media")) parse(text.slice(open + 1, close), prelude.slice(6).trim());
    index = close + 1;
  }
  return rules;
}
/** Evaluates a media condition for a viewport; colour scheme and motion preferences are the defaults (dark, motion allowed). */
function mediaMatches(media: string | null, width: number, height = 800): boolean {
  if (!media) return true;
  return media.split(/\s+and\s+/).every(part => {
    const [, feature, value] = /^\(([a-z-]+):\s*([^)]+)\)$/.exec(part.trim()) ?? [];
    const px = Number.parseFloat(value ?? "");
    switch (feature) {
      case "max-width": return width <= px;
      case "min-width": return width >= px;
      case "max-height": return height <= px;
      case "min-height": return height >= px;
      default: return false;
    }
  });
}
const layoutSelectors = [".app", ".sidebar", ".drawer-scrim", ".menu-button", ".drawer-close", ".main-pane", ".app-header", ".header-title h1", ".content",
  ".scroll-region", ".composer-wrap", ".composer", ".home-composer", ".composer textarea", ".topic-panel", ".palette", ".project-grid", ".create-form:not(:has(select)) .primary",
  ".settings-nav ul", ".proposal-fields", ".team-card", ".setup", ".setup-steps", ".setup-steps li", ".setup-step-name", ".setup-summary div", ".auth"];
const layoutProperties = /^(?:display|position|inset|grid-template-columns|width|min-width|max-width|height|padding(?:-[a-z]+)?|transform|visibility|overflow(?:-x)?|flex-wrap|font-size|margin-top|white-space|text-overflow)$/;
/** The final value of each layout property for each tracked selector at one viewport width. */
function layoutAt(rules: Rule[], width: number): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const rule of rules) {
    if (!layoutSelectors.includes(rule.selector) || !mediaMatches(rule.media, width)) continue;
    for (const [property, value] of rule.declarations) {
      if (!layoutProperties.test(property)) continue;
      const target = (out[rule.selector] ??= {});
      // A shorthand resets its longhands declared before it.
      if (property === "padding") for (const key of Object.keys(target)) if (key.startsWith("padding-")) delete target[key];
      target[property] = value;
    }
  }
  return Object.fromEntries(layoutSelectors.filter(s => out[s]).map(s => [s, Object.fromEntries(Object.entries(out[s]!).sort())]));
}
const widths = [360, 390, 430, 1280] as const;

test("responsive snapshots at 360/390/430/1280 px: drawer, bottom composer and safe areas on phones, columns on desktop", () => {
  const rules = cssRules(decode(staticAssets.get("app.css")!.body));
  const snapshot = Object.fromEntries(widths.map(width => [width, layoutAt(rules, width)]));
  expect(snapshot).toMatchSnapshot();
  for (const width of [360, 390, 430] as const) {
    const at = snapshot[width]!;
    // The sidebar is an off-canvas drawer opened by the menu link (CSS :target without script).
    expect(at[".app"]!.display).toBe("block");
    expect(at[".sidebar"]).toMatchObject({ position: "fixed", transform: "translateX(-102%)", visibility: "hidden", width: "min(86vw, 320px)" });
    expect(at[".menu-button"]!.display).toBe("grid");
    expect(at[".drawer-close"]!.display).toBe("grid");
    // The composer stays at the bottom of the main column and clears the home indicator; inputs never zoom on focus.
    expect(at[".main-pane"]).toMatchObject({ height: "100dvh", "padding-left": "env(safe-area-inset-left)", "padding-right": "env(safe-area-inset-right)" });
    expect(at[".composer-wrap"]!.padding).toBe("10px 12px max(12px, env(safe-area-inset-bottom))");
    expect(at[".composer textarea"]!["font-size"]).toBe("16px");
    expect(at[".app-header"]!["padding-top"]).toBe("max(10px, env(safe-area-inset-top))");
    expect(at[".topic-panel"]).toMatchObject({ position: "fixed", width: "min(92vw, 400px)" });
    expect(at[".project-grid"]!["grid-template-columns"]).toBe("1fr");
    // Setup step names wrap between words and a long word widens its own column, so no step name is cut off.
    expect(at[".setup-step-name"]).toMatchObject({ "white-space": "normal", overflow: "visible" });
    expect(at[".setup-steps li"]!["min-width"]).toBe("auto");
    expect(at[".setup-steps"]!["grid-template-columns"]).toBe("repeat(5, minmax(min-content, 1fr))");
  }
  expect(snapshot[1280]![".app"]).toMatchObject({ display: "grid", "grid-template-columns": "264px minmax(0, 1fr)" });
  expect(snapshot[1280]![".menu-button"]!.display).toBe("none");
  expect(snapshot[1280]![".sidebar"]!.position).toBeUndefined();
  expect(snapshot[1280]![".setup-step-name"]).toMatchObject({ "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" });
});

test("no rule active at 360–430 px sets a fixed width or grid track wider than the viewport", () => {
  const rules = cssRules(decode(staticAssets.get("app.css")!.body));
  for (const width of [360, 390, 430]) {
    const active = rules.filter(rule => mediaMatches(rule.media, width));
    // Selectors whose final display is not grid ignore their grid tracks (e.g. `.app` is a block below 680 px).
    const display = new Map<string, string>();
    for (const rule of active) for (const [p, v] of rule.declarations) if (p === "display") display.set(rule.selector, v);
    for (const rule of active) {
      for (const [property, value] of rule.declarations) {
        if (/^(?:width|min-width|flex-basis)$/.test(property) && /^\d+(?:\.\d+)?px$/.test(value) && Number.parseFloat(value) > width) {
          throw new Error(`${width}px: ${rule.selector} { ${property}: ${value} }`);
        }
        if (property === "grid-template-columns" && display.get(rule.selector) === "grid") {
          let fixed = 0;
          for (const m of value.matchAll(/repeat\((\d+),\s*minmax\((\d+)px/g)) fixed += Number(m[1]) * Number(m[2]);
          for (const m of value.replace(/repeat\([^)]*\)\)?/g, "").matchAll(/(?:^|[\s(])(\d+)px/g)) fixed += Number(m[1]);
          if (fixed > width) throw new Error(`${width}px: ${rule.selector} { grid-template-columns: ${value} }`);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Accessibility checks of the server-rendered HTML

test("accessibility: every main page passes the HTML checks in Thai and English, dark and light", async () => {
  const f = await installation();
  let pages = 0;
  for (const theme of ["dark", "light"] as const) {
    for (const language of ["th", "en"] as const) {
      setPreferences(f, theme, language);
      for (const route of f.routes) {
        const response = await get(f, route);
        expect(response.status).toBe(200);
        const problems = accessibilityProblems(await response.text(), language);
        if (problems.length) throw new Error(`${theme}/${language} ${route}:\n${[...new Set(problems)].join("\n")}`);
        pages++;
      }
    }
  }
  expect(pages).toBe(f.routes.length * 4);
  // Signed-out and error pages, in the browser's language.
  for (const language of ["th", "en"] as const) {
    for (const [path, signedIn] of [["/login", false], ["/projects/00000000-0000-0000-0000-000000000000", true], ["/nope", true]] as const) {
      const response = await get(f, path, { "accept-language": language }, signedIn);
      const html = await response.text();
      const lang = /<html lang="(th|en)"/.exec(html)![1] as "th" | "en";
      const problems = accessibilityProblems(html, lang);
      if (problems.length) throw new Error(`${language} ${path}:\n${problems.join("\n")}`);
    }
  }
});

test("accessibility: every setup step passes the HTML checks in Thai and English, dark and light", async () => {
  for (const language of ["th", "en"] as const) {
    const f = await ux03Installation({ setupLanguage: language });
    installations.push(f);
    const seen = new Set<string>();
    for (const page of f.setupPages) {
      // The requested language and theme are the expected ones; nothing is read back from the page.
      expect(page.html).toStartWith(`<!doctype html><html lang="${language}" data-theme="${page.theme}">`);
      // Labels follow the language: an English step has no Thai in its title or headings.
      if (language === "en") expect(page.html).not.toMatch(/<(title|h1)[^>]*>[^<]*[\u0E00-\u0E7F]/);
      else expect(page.html).toMatch(/<title>[^<]*[\u0E00-\u0E7F]/);
      const problems = accessibilityProblems(page.html, language);
      if (problems.length) throw new Error(`${page.step}/${language}/${page.theme}:\n${problems.join("\n")}`);
      seen.add(`${page.step}/${page.theme}`);
    }
    expect(seen.size).toBe(12);
    expect(new Set(f.setupPages.map(p => p.step))).toEqual(new Set(["wake", "connect", "connect-checked", "know", "personality", "ceremony"]));
  }
});

test("accessibility: the checker itself rejects the problems it looks for", () => {
  const page = (body: string) =>
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>T</title></head><body><a class="skip" href="#main-content">Skip</a><main id="main-content"><h1>T</h1>${body}</main></body></html>`;
  expect(accessibilityProblems(page(""), "en")).toEqual([]);
  expect(accessibilityProblems(page('<div hidden><button></button></div><input type="submit" value="Send"><input type="submit"><span id="l">Name</span><input aria-labelledby="l">'), "en")).toEqual([]);
  expect(accessibilityProblems(page(""), "th")).toEqual(["html lang en (expected th)"]);
  const cases: [string, RegExp][] = [
    ['<button><svg aria-hidden="true"></svg></button>', /no accessible name/],
    ['<a href="/x"></a>', /no accessible name/],
    ['<input name="q">', /has no label/],
    ['<label for="nope">Q</label>', /points nowhere/],
    ['<svg viewBox="0 0 1 1"></svg>', /neither decorative nor labelled/],
    ['<div tabindex="2">x</div>', /positive tabindex/],
    ['<p id="a">1</p><p id="a">2</p>', /duplicate id/],
    ["<nav><a href=\"/\">x</a></nav>", /nav without a name/],
    ['<nav aria-label="A"></nav><nav aria-label="A"></nav>', /share a name/],
    ['<fieldset><input type="radio" aria-label="x"></fieldset>', /fieldset without legend/],
    ["<h2></h2>", /empty heading/],
    ["<li>x</li>", /li outside a list/],
    ['<a href="#nowhere">x</a>', /missing id/],
    ['<a href="/" aria-hidden="true">x</a>', /aria-hidden but focusable/],
    ["<h1>Two</h1>", /2 h1 headings/],
    ["<p><span></p>", /mismatched/],
    ['<div aria-hidden="true"><button>Hidden control</button></div>', /aria-hidden but focusable/],
    ['<span id="">Unrelated</span><input id="x">', /invalid id ""[\s\S]*has no label/],
    ['<span id="">Unrelated</span><button aria-labelledby=" "></button>', /invalid id[\s\S]*no accessible name/],
    ['<span id="">Unrelated</span><nav aria-labelledby=""></nav>', /nav without a name/],
    ['<select id=""><option>A</option></select>', /invalid id[\s\S]*has no label/],
    ['<label for="">Name</label><textarea id=""></textarea>', /invalid id[\s\S]*has no label/],
    ['<button>Choose<select aria-label="Choice"><option>A</option></select></button>', /nests interactive content/],
    ['<a href="/x">Go<textarea aria-label="T"></textarea></a>', /nests interactive content/],
    ['<button><span hidden>Hidden name</span></button>', /no accessible name/],
    ['<button><span aria-hidden="true">Hidden name</span></button>', /no accessible name/],
    ['<input type="submit" value="">', /no accessible name/],
    ['<input type="button">', /no accessible name/],
    ['<span id="empty"></span><input aria-labelledby="empty">', /has no label/],
    ['<span id="empty2"></span><button aria-labelledby="empty2">Text</button>', /no accessible name/],
    ['<label for="q2"><span aria-hidden="true">Q</span></label><input id="q2">', /has no label/],
  ];
  for (const [body, problem] of cases) expect(accessibilityProblems(page(body), "en").join("\n")).toMatch(problem);
  // Unnamed controls in every native-label shape: each control kind, label[for] or wrapping label, hidden or aria-hidden
  // label, and an empty aria-labelledby beside a working label (it decides alone).
  const controls = { input: (id: string, extra = "") => `<input id="${id}"${extra}>`, select: (id: string, extra = "") => `<select id="${id}"${extra}><option>A</option></select>`,
    textarea: (id: string, extra = "") => `<textarea id="${id}"${extra}></textarea>` };
  let rows = 0;
  for (const [kind, control] of Object.entries(controls)) {
    for (const hide of ["hidden", 'aria-hidden="true"']) {
      for (const body of [`<label for="c" ${hide}>Name</label>${control("c")}`, `<div ${hide}><label for="c">Name</label></div>${control("c")}`, `<label ${hide}>Name ${control("c")}</label>`]) {
        const problems = accessibilityProblems(page(body), "en").join("\n");
        // A control inside its own hidden wrapping label is hidden too; that variant is reported as hidden-but-focusable or skipped.
        if (body.startsWith("<label hidden>")) continue;
        expect(problems, `${kind}: ${body}`).toMatch(/has no label|aria-hidden but focusable/);
        rows++;
      }
    }
    expect(accessibilityProblems(page(`<span id="e"></span><label for="c">Name</label>${control("c", ' aria-labelledby="e"')}`), "en").join("\n"), kind).toMatch(/has no label/);
    expect(accessibilityProblems(page(`<span id="e"></span><label>Name ${control("c", ' aria-labelledby="e"')}</label>`), "en").join("\n"), kind).toMatch(/has no label/);
    // A wrapped control's own content is not its name.
    expect(accessibilityProblems(page(`<label>${control("c")}</label>`), "en").join("\n"), kind).toMatch(/has no label/);
    // Positive: a referenced label may itself be hidden, and a visible label names the control.
    expect(accessibilityProblems(page(`<span id="h" hidden>Name</span>${control("c", ' aria-labelledby="h"')}<label for="d">Name</label>${control("d")}`), "en"), kind).toEqual([]);
    // A label is associated only through `for` naming this control, or as the first labelable descendant without `for`.
    for (const body of [`<label for="o">Name ${control("c")}</label><input id="o" aria-label="Other">`, `<label for="">Name ${control("c")}</label>`,
      `<label>Name <input id="first" aria-label="First"> ${control("c")}</label>`]) {
      expect(accessibilityProblems(page(body), "en").join("\n"), `${kind}: ${body}`).toMatch(/#c[^\n]*has no label/);
      rows++;
    }
    expect(accessibilityProblems(page(`<label for="c">Name</label><label>Other ${control("d")}</label>${control("c")}`), "en"), kind).toEqual([]);
    rows += 3;
  }
  expect(rows).toBe(3 * (5 + 3 + 3));
});

test("keyboard and motion: visible focus everywhere, outline removed only with a replacement, and reduced motion stops all motion", () => {
  const css = decode(staticAssets.get("app.css")!.body);
  const rules = cssRules(css);
  expect(css).toContain("a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {\n  outline: 2px solid var(--fg);\n  outline-offset: 2px;\n}");
  // Where a control drops its own outline, its container shows focus instead.
  const removed = rules.filter(rule => rule.declarations.some(([p, v]) => p === "outline" && /^(?:none|0)$/.test(v))).map(rule => rule.selector);
  expect(removed.sort()).toEqual([".composer textarea:focus-visible", ".create-form input:focus-visible", ".palette-form input"]);
  for (const container of [".composer:focus-within", ".create-form:focus-within", ".palette-form:focus-within"]) {
    expect(rules.find(rule => rule.selector === container)?.declarations.some(([p]) => p === "box-shadow")).toBe(true);
  }
  // Reduced motion: one universal rule ends every animation and transition, including the breathing dot and the ceremony.
  const reduced = rules.filter(rule => rule.media === "(prefers-reduced-motion: reduce)");
  expect(reduced.find(rule => rule.selector === "*")?.declarations).toEqual([["scroll-behavior", "auto !important"], ["animation", "none !important"], ["transition", "none !important"]]);
  expect(reduced.map(rule => rule.selector)).toEqual(expect.arrayContaining(["*", "*::before", "*::after"]));
  expect(css.indexOf("prefers-reduced-motion")).toBeGreaterThan(css.lastIndexOf("@keyframes"));
  const js = decode(staticAssets.get("app.js")!.body);
  expect(js).toContain('matchMedia?.("(prefers-reduced-motion: reduce)").matches');
  expect(js).not.toMatch(/behavior: "smooth"|scrollTo\(/);
  // The drawer is out of the tab order when closed (visibility: hidden) and reachable through the menu link.
  expect(rules.some(rule => rule.media === "(max-width: 680px)" && rule.selector === ".sidebar" && rule.declarations.some(([p, v]) => p === "visibility" && v === "hidden"))).toBe(true);
});
