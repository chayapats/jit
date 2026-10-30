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
const regions = [["s14-live"], ["s14-pane-live", "s14-work-status", "s14-pane-status"]];
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
      if (current.innerHTML !== fresh.innerHTML) current.innerHTML = fresh.innerHTML;
      if (current.className !== fresh.className) current.className = fresh.className;
    }
  }
  const revision = next.querySelector("[data-composer] input[name=expectedRevision]"), mine = document.querySelector("[data-composer] input[name=expectedRevision]");
  if (revision && mine && mine.value !== revision.value) mine.value = revision.value;
  const phase = next.querySelector(".s-pane .s-pill, .s-col > .s-between .s-pill")?.textContent ?? "";
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
