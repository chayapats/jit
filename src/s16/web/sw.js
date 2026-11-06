// Jit S16 notification worker (s16-notifications/v1). Hand-written classic script, no dependencies, no build step.
// It shows Web Push notices and opens their in-app path. It has no fetch handler and caches no response: pages, API
// and every authenticated answer always go to the network. A notice payload carries only an opaque ID, a kind and a
// same-origin path; the title and body come from the localized text Jit fills into the line below, so nothing private
// is shown, stored or sent. A notification only opens the conversation; it never approves, decides or starts anything.
const config = { copy: {}, icon: null };

const kinds = ["needs_you", "result", "routine"];
const paths = /^\/s16(?:\/(?:chat|routines)\/[A-Za-z0-9_-]{1,128})?$/;
const prefs = "jit-s16-notification-prefs";
const localeKey = "/s16/sw-locale";

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", event => { event.waitUntil(self.clients.claim()); });

// The page tells the worker its language when the owner turns notifications on or changes the language.
self.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "jit-locale" || (data.locale !== "en" && data.locale !== "th")) return;
  if (event.source && typeof event.source.url === "string" && new URL(event.source.url).origin !== self.location.origin) return;
  event.waitUntil(caches.open(prefs).then(cache => cache.put(localeKey, new Response(data.locale))).catch(() => {}));
});

async function locale() {
  try {
    const hit = await (await caches.open(prefs)).match(localeKey), value = hit ? await hit.text() : null;
    if (value === "en" || value === "th") return value;
  } catch { /* No stored preference: use the browser language. */ }
  const language = String((self.navigator && self.navigator.language) || "").toLowerCase();
  return language.startsWith("en") ? "en" : "th";
}

function notice(event) {
  try {
    const value = event.data ? event.data.json() : null;
    if (value && value.v === 1 && typeof value.id === "string" && /^nt_[a-f0-9]{32}$/.test(value.id) && kinds.includes(value.kind) && typeof value.path === "string" && paths.test(value.path)) return value;
  } catch { /* An unreadable payload still shows the generic notice below. */ }
  return null;
}

self.addEventListener("push", event => {
  const value = notice(event);
  event.waitUntil(locale().then(language => {
    const text = config.copy[language] || config.copy.en, kind = value ? value.kind : "generic";
    // The tag is the durable notice ID: a repeated push of the same notice replaces it instead of adding another.
    const options = { body: text[`${kind}.body`], tag: value ? value.id : "jit-generic", lang: language, data: { path: value ? value.path : "/s16" } };
    if (config.icon) options.icon = config.icon;
    return self.registration.showNotification(text[`${kind}.title`], options);
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const requested = event.notification.data && event.notification.data.path;
  const path = typeof requested === "string" && paths.test(requested) ? requested : "/s16";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(client => new URL(client.url).origin === self.location.origin && new URL(client.url).pathname === path);
    // The page re-fetches its authenticated state; the message only asks it to do so now.
    if (open) { open.postMessage({ type: "jit-notice-open", path }); return open.focus(); }
    return self.clients.openWindow(new URL(path, self.location.origin).href);
  })());
});
