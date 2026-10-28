// Jit service worker (web.pwa/v1, ADR 0028). Hand-written classic script, no dependencies, no build step.
// It caches only the hashed static asset table that Jit generates into the line below: stylesheet, scripts, fonts
// and icons. It never caches pages, API, event streams or any authenticated or owner response, never answers a
// request outside that list, and has no background sync, push or periodic work. A new asset version opens a new
// cache and deletes every older one. Signing out leaves nothing to clear, because no owner data is ever stored.
const table = { version: "", paths: [] };

const cacheName = `jit-static-${table.version}`;
const allowed = new Set(table.paths);

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(table.paths)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys()
    .then(names => Promise.all(names.filter(name => name !== cacheName).map(name => caches.delete(name))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  // Exact same-origin hashed paths only; a query, another origin or any other path goes to the network untouched.
  if (url.origin !== self.location.origin || url.search || !allowed.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    const hit = await cache.match(url.pathname);
    if (hit) return hit;
    const response = await fetch(request);
    // Only a complete same-origin answer is kept; the hashed path names one immutable body. The write is part of the
    // event's lifetime, so the browser keeps the worker alive until it finishes, and a failed write only means a
    // later miss: the page still gets the network answer.
    if (response.status === 200 && response.type === "basic") event.waitUntil(cache.put(url.pathname, response.clone()).catch(() => {}));
    return response;
  })());
});
