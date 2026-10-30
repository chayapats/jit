// S14 browser enhancements (ADR 0028). Hand-written ES module, no dependencies, no build step.
// Every S14 page is complete without this file: forms post, the composer's work mode is a checkbox and limits are visible.
// It only adds Enter to send, the setup ceremony, focus on an opened approval slip and same-origin reads of the page
// being viewed while something is in flight. It never posts data itself and stores nothing.

document.documentElement.dataset.enhanced = "true";

for (const form of document.querySelectorAll("[data-composer]")) {
  const text = form.querySelector("textarea");
  text?.addEventListener("keydown", event => {
    // Thai and other IMEs use Enter to confirm a composition; that must not send.
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || !text.value.trim()) return;
    event.preventDefault();
    form.requestSubmit();
  });
  if (location.hash === "#s14-text" && text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }
}

// A slip opened from Work or a notification takes focus on its heading, never on Approve.
document.querySelector("[data-focus-on-load]")?.focus({ preventScroll: false });

const ceremony = document.querySelector("[data-ceremony-form]");
ceremony?.addEventListener("submit", event => {
  const stage = document.querySelector("[data-ceremony]");
  if (!stage || ceremony.dataset.played || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  event.preventDefault();
  ceremony.dataset.played = "true";
  stage.dataset.ceremony = "playing";
  setTimeout(() => ceremony.submit(), 1600);
});

// Live reads: refetch this same page while work or a reply is in flight and replace only its typed regions.
const regions = [["s14-live"], ["s14-pane-live", "s14-work-status", "s14-pane-status"], ["s14-computer-screen"], ["s14-computer-more"]];
const status = document.getElementById("s-phase");
let replies = document.querySelectorAll(".s-bot-text").length;
const busy = region => region.contains(document.activeElement) && document.activeElement !== document.body || region.querySelector("details[open]");
async function refresh() {
  const response = await fetch(location.href, { headers: { Accept: "text/html" }, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) return false;
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  let deferred = false;
  for (const group of regions) {
    const pairs = group.map(id => [document.getElementById(id), next.getElementById(id)]).filter(([current, fresh]) => current && fresh);
    if (pairs.some(([current]) => busy(current))) { deferred = true; continue; }
    for (const [current, fresh] of pairs) {
      // Preserve computer forms and their request IDs when the authoritative signature is unchanged.
      if (current.dataset.sig && current.dataset.sig === fresh.dataset.sig) continue;
      if (current.innerHTML !== fresh.innerHTML) current.innerHTML = fresh.innerHTML;
      if (fresh.dataset.sig) current.dataset.sig = fresh.dataset.sig;
      if (current.className !== fresh.className) current.className = fresh.className;
    }
  }
  const revision = next.querySelector("[data-composer] input[name=expectedRevision]"), mine = document.querySelector("[data-composer] input[name=expectedRevision]");
  if (revision && mine && mine.value !== revision.value) mine.value = revision.value;
  const typed = next.querySelector("[data-phase]")?.dataset.phase, phase = typed ?? next.querySelector(".s-pane .s-pill, .s-col > .s-between .s-pill")?.textContent ?? "";
  if (status && phase && status.textContent !== phase) status.textContent = phase;
  else if (status && next.querySelectorAll(".s-bot-text").length > replies) status.textContent = status.dataset.reply;
  replies = next.querySelectorAll(".s-bot-text").length;
  return deferred || !!next.querySelector("[data-live]");
}
if (document.querySelector("[data-live]")) {
  const tick = async () => {
    let live = true;
    try { live = await refresh(); } catch { /* A failed read only delays the next one; the page already shows its last state. */ }
    if (live) setTimeout(tick, 2500);
  };
  setTimeout(tick, 2500);
}

// Bot computer. Forms already do everything; script fits the screen to the page, keeps the picture fresh and follows
// the one-event state stream. Input stays on the page's own forms, so a press is still one browser form submission.
const computer = document.querySelector("[data-computer]");
if (computer) {
  const api = `/api/s14/bots/${computer.dataset.computer}/computer`;
  let known = computer.dataset.key, read = Date.now(), source = null;
  // Preloading keeps the last picture on screen; a failed read leaves it there.
  const repaint = () => {
    if (!document.querySelector("[data-screen]")) return;
    const image = new Image();
    image.onload = () => { const screen = document.querySelector("[data-screen]"); if (screen) screen.src = image.src; };
    image.src = `${api}/image?t=${Date.now()}`;
  };
  // The fitted image is scaled, so its click is mapped back to the 1280 by 800 surface and posted by the same form.
  document.addEventListener("click", event => {
    const image = event.target;
    if (!image.matches?.("input[type=image][data-screen]")) return;
    event.preventDefault();
    const form = image.form, box = image.getBoundingClientRect(), scaled = (offset, size, max) => Math.max(0, Math.min(max, Math.floor(offset * (max + 1) / size)));
    if (form.dataset.pressed) return;
    form.dataset.pressed = "true";
    for (const [name, value] of [["point.x", scaled(event.clientX - box.left, box.width, 1279)], ["point.y", scaled(event.clientY - box.top, box.height, 799)]]) {
      const field = document.createElement("input");
      Object.assign(field, { type: "hidden", name, value });
      form.append(field);
    }
    form.requestSubmit();
  });
  const listen = () => {
    source = new EventSource(`${api}/events`);
    source.addEventListener("state", async event => {
      const { computer: current, lease } = JSON.parse(event.data), key = `${current?.revision ?? 0}.${current?.generation ?? 0}.${lease?.revision ?? 0}`;
      // The minute check keeps the time left honest and shows a lease that expired with no state change.
      if (key !== known || Date.now() - read > 60000) { known = key; read = Date.now(); try { await refresh(); } catch { /* The next event tries again. */ } }
      if (current?.state === "running") repaint();
    });
  };
  const follow = () => { if (document.hidden) { source?.close(); source = null; } else if (!source) listen(); };
  document.addEventListener("visibilitychange", follow);
  follow();
}
