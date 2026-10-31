// S14 browser enhancements (ADR 0028). Hand-written ES module, no dependencies, no build step.
// Every S14 page is complete without this file: forms post, the composer's work mode is a checkbox and limits are visible.
// It only adds Enter to send, the setup ceremony, focus on an opened approval slip, a device timezone, copying a sign-in code or setup value, moving on from the Google return page and same-origin
// reads of the page being viewed while something is in flight. It never posts data itself and stores nothing.

document.documentElement.dataset.enhanced = "true";

const wireComposers = () => {
  for (const form of document.querySelectorAll("[data-composer]")) {
    if (form.dataset.wired) continue;
    form.dataset.wired = "true";
    const text = form.querySelector("textarea");
    text?.addEventListener("keydown", event => {
      // Thai and other IMEs use Enter to confirm a composition; that must not send.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || !text.value.trim()) return;
      event.preventDefault();
      form.requestSubmit();
    });
    if (location.hash === "#s14-text" && text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }
  }
};
wireComposers();

// A new routine starts from the host's timezone; this device's is the better guess. Both stay visible, editable and reviewed.
for (const input of document.querySelectorAll("[data-device-timezone]")) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone) input.value = zone;
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

// Device sign-in: the first page holds the only copy of the code, so it stays on screen and only the safe state is read.
// A settled flow reloads the page's own read-only address, which never carries the code.
const signIn = document.querySelector("[data-sign-in]");
if (signIn) {
  const poll = async () => {
    let state = "pending";
    try {
      const response = await fetch(signIn.dataset.signIn, { credentials: "same-origin", cache: "no-store" });
      // An expired session needs the page's own redirect; any other failed read only delays the next one.
      if (response.status === 401 || response.status === 403) {
        location.replace(signIn.dataset.signInPage);
        return;
      }
      if (response.ok) ({ state } = await response.json());
    } catch { /* A failed read only delays the next one. */ }
    if (state === "pending" || state === "starting") setTimeout(poll, 3000);
    else location.replace(signIn.dataset.signInPage);
  };
  setTimeout(poll, 3000);
}
// The page after Google has one link. Following it here replaces the page, so Back never lands on it, and the navigation starts on this origin.
const onward = document.querySelector("a[data-go]");
if (onward) location.replace(onward.href);

for (const button of document.querySelectorAll("[data-copy]")) {
  const target = button.dataset.copyTarget || button.dataset.copy;
  const source = target ? document.getElementById(target) : document.querySelector("[data-copy-source]");
  if (!source || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(source.textContent);
    button.textContent = button.dataset.copied;
  });
}

// Live reads: refetch this same page while work or a reply is in flight and replace only its typed regions.
const regions = [["s14-live", "s14-backup-list", "s14-backup-restore", "s14-backup-version"], ["s14-bot-overview"], ["s14-pane-live", "s14-work-status", "s14-pane-status"], ["s14-computer-status"], ["s14-computer-screen"], ["s14-computer-more"]];
const status = document.getElementById("s-phase");
let replies = document.querySelectorAll(".s-bot-text").length;
let expectedComputerKey = document.querySelector("[data-computer]")?.dataset.key;
const busy = region => region.contains(document.activeElement) && document.activeElement !== document.body || region.querySelector("details[open]");
async function refresh() {
  const response = await fetch(location.href, { headers: { Accept: "text/html" }, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("page_refresh_failed");
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  const computerKey = next.querySelector("[data-computer]")?.dataset.key;
  // A response that predates the latest state event cannot re-enable stale computer controls.
  if (expectedComputerKey !== undefined && computerKey !== expectedComputerKey) return { complete: false, live: true, computerKey };
  let deferred = false;
  for (const group of regions) {
    const pairs = group.map(id => [document.getElementById(id), next.getElementById(id)]).filter(([current, fresh]) => current && fresh);
    if (pairs.some(([current]) => busy(current))) { deferred = true; continue; }
    for (const [current, fresh] of pairs) {
      // Preserve computer forms and their request IDs when the authoritative signature is unchanged.
      const stale = !!current.querySelector("[data-computer-stale]");
      if (current.dataset.sig && current.dataset.sig === fresh.dataset.sig && !stale) continue;
      if (stale || current.innerHTML !== fresh.innerHTML) current.innerHTML = fresh.innerHTML;
      if (fresh.dataset.sig) current.dataset.sig = fresh.dataset.sig;
      if (current.className !== fresh.className) current.className = fresh.className;
    }
  }
  // The foot of a chat changes only when the Bot can or cannot take a message, so a read never replaces text being typed.
  const dock = document.getElementById("s14-dock"), freshDock = next.getElementById("s14-dock");
  if (dock && freshDock && dock.dataset.sig !== freshDock.dataset.sig) {
    if (busy(dock)) deferred = true;
    else {
      dock.innerHTML = freshDock.innerHTML;
      dock.dataset.sig = freshDock.dataset.sig;
      wireComposers();
      if (status) status.textContent = freshDock.dataset.announce;
    }
  }
  const revision = next.querySelector("[data-composer] input[name=expectedRevision]"), mine = document.querySelector("[data-composer] input[name=expectedRevision]");
  if (revision && mine && mine.value !== revision.value) mine.value = revision.value;
  const typed = next.querySelector("[data-phase]")?.dataset.phase, phase = typed ?? next.querySelector(".s-pane .s-pill, .s-col > .s-between .s-pill")?.textContent ?? "";
  if (status && phase && status.textContent !== phase) status.textContent = phase;
  else if (status && next.querySelectorAll(".s-bot-text").length > replies) status.textContent = status.dataset.reply;
  replies = next.querySelectorAll(".s-bot-text").length;
  return { complete: !deferred, live: deferred || !!next.querySelector("[data-live]"), computerKey };
}
if (document.querySelector("[data-live]")) {
  const tick = async () => {
    let live = true;
    try { live = (await refresh()).live; } catch { /* A failed read only delays the next one. */ }
    if (live) setTimeout(tick, 2500);
  };
  setTimeout(tick, 2500);
}

// Bot computer. Forms already do everything; script fits the screen to the page, keeps the picture fresh and follows
// the one-event state stream. Input stays on the page's own forms, so a press is still one browser form submission.
const computer = document.querySelector("[data-computer]");
if (computer) {
  const api = `/api/s14/bots/${computer.dataset.computer}/computer`;
  let known = computer.dataset.key, read = Date.now(), source = null, pending = false, refreshing = false;
  const fenceForms = () => {
    pending = true;
    // Presentation only: service lease/generation checks remain the authority boundary.
    for (const form of computer.querySelectorAll("form")) {
      form.dataset.computerStale = "true";
      for (const control of form.elements) control.disabled = true;
    }
  };
  const sync = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const result = await refresh();
      pending = !result.complete || result.computerKey !== expectedComputerKey;
      if (!pending) { known = result.computerKey; read = Date.now(); }
    } catch { pending = true; }
    finally { refreshing = false; }
  };
  // Retry deferred regions as soon as their focused field or open details stops being busy.
  const retry = () => { if (pending) return sync(); };
  document.addEventListener("focusout", () => setTimeout(retry, 0));
  document.addEventListener("toggle", retry, true);
  document.addEventListener("submit", event => { if (event.target.matches?.("[data-computer-stale]")) event.preventDefault(); }, true);
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
    if (image.disabled || form.dataset.computerStale || form.dataset.pressed) return;
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
      if (key !== expectedComputerKey || lease?.actor === "owner" && lease.expiresAt <= Date.now() && computer.querySelector("[data-computer-input]")) fenceForms();
      expectedComputerKey = key;
      if (key !== known || pending || Date.now() - read > 60000) { pending = true; await sync(); }
      if (current?.state === "running") repaint();
    });
  };
  const follow = () => { if (document.hidden) { source?.close(); source = null; } else if (!source) listen(); };
  document.addEventListener("visibilitychange", follow);
  follow();
}
