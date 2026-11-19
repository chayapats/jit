// s16-desktop-release/v1: only the generated public inventory may enter this cache.
// Authenticated pages, APIs, files, screenshots and effects are never cached or retried.
const desktop = config.desktop;
const desktopPrefix = "jit-s16-client-v1-";
const desktopCache = desktopPrefix + desktop.id;
const desktopMarker = new URL("/s16/.desktop-complete", self.location.origin).href;
const desktopAssets = new Map(desktop.assets.map(asset => [new URL(asset.path, self.location.origin).href, asset]));
const desktopDocuments = /^\/s16(?:\/?|\/(?:memory|artifacts|routines|bots|computers|connections)|\/(?:chat|artifacts|routines|bots)\/[A-Za-z0-9_-]{1,128})$/;
const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), value => value.toString(16).padStart(2, "0")).join("");

async function desktopBytes(response, asset) {
  if (!response || response.status !== 200 || response.redirected || response.headers.get("content-type") !== asset.contentType || !response.body) throw new Error("desktop_asset_invalid");
  const reader = response.body.getReader(), parts = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > asset.bytes) throw new Error("desktop_asset_limit"); parts.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  if (size !== asset.bytes) throw new Error("desktop_asset_truncated");
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  if (await digest(bytes) !== asset.sha256) throw new Error("desktop_asset_hash");
  return bytes;
}

async function desktopComplete() {
  const cache = await caches.open(desktopCache), marker = await cache.match(desktopMarker);
  if (!marker) return false;
  try {
    const value = await marker.json(); if (value.id !== desktop.id) return false;
    for (const asset of desktop.assets) await desktopBytes(await cache.match(asset.path), asset);
    return true;
  } catch { return false; }
}

let desktopInstalling = null;
async function desktopInstall() {
  if (desktopInstalling) return desktopInstalling;
  desktopInstalling = (async () => {
    if (await desktopComplete()) return;
    const staging = desktopCache + "-staging-" + crypto.randomUUID(), stage = await caches.open(staging);
    const stop = new AbortController(), timer = setTimeout(() => stop.abort(), 30000);
    try {
      for (const asset of desktop.assets) {
        const url = new URL(asset.path, self.location.origin);
        if (url.origin !== self.location.origin || !/^\/s16\/assets\/[a-f0-9]{64}\/[a-z0-9.-]+$/.test(url.pathname) || asset.bytes > 4194304) throw new Error("desktop_inventory_invalid");
        const response = await fetch(url.href, { credentials: "omit", redirect: "error", cache: "no-store", signal: stop.signal });
        const bytes = await desktopBytes(response, asset);
        await stage.put(url.href, new Response(bytes, { headers: { "Content-Type": asset.contentType } }));
      }
      // Cache Storage has no rename. The marker is the commit point: a partial final copy is never selectable.
      const target = await caches.open(desktopCache);
      for (const asset of desktop.assets) await target.put(asset.path, await stage.match(asset.path));
      await target.put(desktopMarker, Response.json({ id: desktop.id, completedAt: Date.now() }));
      if (!await desktopComplete()) { await target.delete(desktopMarker); throw new Error("desktop_package_incomplete"); }
    } finally { clearTimeout(timer); await caches.delete(staging); }
  })();
  try { return await desktopInstalling; } finally { desktopInstalling = null; }
}

self.addEventListener("install", event => { event.waitUntil(desktopInstall()); });
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    if (!await desktopComplete()) throw new Error("desktop_package_incomplete");
    const candidates = [];
    for (const name of await caches.keys()) {
      if (!name.startsWith(desktopPrefix) || name === desktopCache) continue;
      const marker = await (await caches.open(name)).match(desktopMarker);
      try { const value = marker ? await marker.json() : null; if (value && /^[a-f0-9]{64}$/.test(value.id) && name === desktopPrefix + value.id && Number.isFinite(value.completedAt)) candidates.push({ name, time: value.completedAt }); }
      catch { /* An incomplete package is never a recovery candidate. */ }
    }
    candidates.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
    const retain = new Set([desktopCache, candidates[0] && candidates[0].name]);
    for (const name of await caches.keys()) if (name.startsWith(desktopPrefix) && !retain.has(name)) await caches.delete(name);
  })());
});

async function desktopPublic(path) {
  const asset = desktopAssets.get(new URL(path, self.location.origin).href);
  if (!asset) throw new Error("desktop_asset_unknown");
  const cache = await caches.open(desktopCache);
  // Expected hashes come from this worker, never from a mutable cache marker or a page-provided inventory.
  const bytes = await desktopBytes(await cache.match(path), asset);
  return new Response(bytes, { headers: { "Content-Type": asset.contentType, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", ...(asset.contentType.startsWith("text/html") ? { "Content-Security-Policy": config.desktopCsp } : {}) } });
}

self.addEventListener("fetch", event => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.search || url.username || url.password) return;
  const navigation = request.mode === "navigate" && desktopDocuments.test(url.pathname);
  if (!navigation && !desktopAssets.has(url.href)) return;
  event.respondWith((async () => {
    try {
      if (!await desktopComplete()) await desktopInstall();
      const language = navigation ? await locale() : null;
      return await desktopPublic(navigation ? desktop.shells[language === "en" ? "en" : "th"] : url.pathname);
    } catch {
      return new Response(navigation ? config.desktopRecovery : "", { status: 503, headers: { "Content-Type": navigation ? "text/html; charset=utf-8" : "text/plain", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
    }
  })());
});

// A capability-free status response, sent only to a same-origin app window's private reply port.
self.addEventListener("message", event => {
  if (event.data?.type !== "jit-desktop-status" || !event.ports?.[0] || !event.source || typeof event.source.url !== "string") return;
  const url = new URL(event.source.url);
  if (url.origin !== self.location.origin || !desktopDocuments.test(url.pathname)) return;
  event.waitUntil(desktopComplete().then(ready => { event.ports[0].postMessage({ contract: "s16-desktop-status/v1", id: desktop.id, ready }); event.ports[0].close(); }));
});
