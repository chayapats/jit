// S14 browser enhancements (ADR 0028). Hand-written ES module, no dependencies, no build step.
// Every S14 page is complete without this file: forms post, the composer's work mode is a checkbox and limits are visible.
// It only adds Enter to send, focus on an opened approval slip, a device timezone, copying a sign-in code or setup value, moving on from the Google return page and same-origin
// reads of the page being viewed while something is in flight. It never posts data itself. Owner-approved local composer
// drafts are text only, expire after 30 days, and never restore grants, modes, revisions or approval decisions.

document.documentElement.dataset.enhanced = "true";

let wireBrowserDrafts = () => {};
const composerStates = new WeakMap();
const syncComposer = form => composerStates.get(form)?.();
const wireComposers = () => {
  for (const form of document.querySelectorAll("[data-composer]")) {
    if (form.dataset.wired) continue;
    form.dataset.wired = "true";
    const text = form.querySelector("textarea");
    const mode = form.querySelector("input[name=work]"), send = form.querySelector(".s-send");
    const sendLabel = () => {
      const label = mode?.checked ? form.dataset.sendWork : form.dataset.sendChat;
      if (label && send) { send.setAttribute("aria-label", label); send.setAttribute("title", label); }
    };
    mode?.addEventListener("change", sendLabel);
    sendLabel();
    const scope = form.querySelector("[data-scope-summary]"), choices = form.querySelector("[data-grant-options]");
    if (scope) {
      const describe = () => {
        const selected = [...form.querySelectorAll("input[data-grant-label]:checked")].map(input => input.dataset.grantLabel);
        scope.textContent = [form.dataset.leadName, ...selected].filter(Boolean).join(" · ");
        scope.hidden = false;
      };
      describe(); form.addEventListener("change", describe);
      composerStates.set(form, () => { sendLabel(); describe(); });
      if (choices && form.dataset.refused !== "true") choices.open = false;
    }
    else composerStates.set(form, sendLabel);
    text?.addEventListener("keydown", event => {
      // Thai and other IMEs use Enter to confirm a composition; that must not send.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || !text.value.trim()) return;
      event.preventDefault();
      form.requestSubmit();
    });
  }
  wireBrowserDrafts();
};
wireComposers();
if (location.hash === "#s14-text") {
  const text = document.querySelector("[data-composer] textarea");
  if (text) { text.focus(); text.setSelectionRange(text.value.length, text.value.length); }
}

// A composer leaves when its Bot can't take a message. What was typed and chosen is held here and goes onto the next
// composer's own fields, so hidden request IDs and revision-bound values stay fresh and a choice no longer offered stays gone.
let heldDraft = null;
const draftFields = form => [...form.elements].filter(field => field.name && !["hidden", "submit", "button", "radio"].includes(field.type));
const holdDraft = form => {
  const fields = draftFields(form);
  return { values: new Map(fields.map(field => [field.name, field.type === "checkbox" ? field.checked : field.value])),
    text: fields.filter(field => field.tagName === "TEXTAREA" || field.type === "text").map(field => field.value).filter(value => value.trim()).join("\n\n"),
    open: [...form.querySelectorAll("details")].map(item => item.open) };
};
const restoreDraft = (form, held) => {
  for (const field of draftFields(form)) {
    if (!held.values.has(field.name)) continue;
    if (field.type === "checkbox") field.checked = held.values.get(field.name);
    else field.value = held.values.get(field.name);
  }
  [...form.querySelectorAll("details")].forEach((item, index) => { if (held.open[index]) item.open = true; });
  syncComposer(form);
};

// A new routine starts from the host's timezone; this device's is the better guess. Both stay visible, editable and reviewed.
for (const input of document.querySelectorAll("[data-device-timezone]")) {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (zone) input.value = zone;
}

// A slip opened from Work or a notification takes focus on its heading, never on Approve.
document.querySelector("[data-focus-on-load]")?.focus({ preventScroll: false });

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
const regions = [["s14-attention-badge", "s14-nav-work", "s14-mobile-work"], ["s14-work-list"], ["s14-live", "s14-backup-list", "s14-backup-restore", "s14-backup-version"], ["s14-bot-overview"], ["s14-pane-live", "s14-work-status", "s14-pane-status"], ["s14-progress-primary", "s14-work-status", "s14-pane-status"], ["s14-progress-details"], ["s14-computer-status"], ["s14-computer-screen"], ["s14-computer-more"]];
const displayedConversation = document.querySelector(".s-app[data-conversation]")?.dataset.conversation;
const liveAddress = displayedConversation && location.pathname === "/" ? `/chats/${encodeURIComponent(displayedConversation)}${location.search}` : location.href;
const status = document.getElementById("s-phase");
let replies = document.querySelectorAll(".s-bot-text").length;
let expectedComputerKey = document.querySelector("[data-computer]")?.dataset.key;
const busy = region => region.contains(document.activeElement) && document.activeElement !== document.body || region.querySelector("details[open]");
async function refresh() {
  const response = await fetch(liveAddress, { headers: { Accept: "text/html" }, credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("page_refresh_failed");
  const next = new DOMParser().parseFromString(await response.text(), "text/html");
  // A shared last-room cookie or redirected read must never mix another room's messages with this form.
  if (displayedConversation && next.querySelector(".s-app[data-conversation]")?.dataset.conversation !== displayedConversation) return { complete: false, live: true };
  const computerKey = next.querySelector("[data-computer]")?.dataset.key;
  // A response that predates the latest state event cannot re-enable stale computer controls.
  if (expectedComputerKey !== undefined && computerKey !== expectedComputerKey) return { complete: false, live: true, computerKey };
  let deferred = false;
  const inline = [...document.querySelectorAll("[data-inline-work]")].map(region => [region.id]);
  for (const group of [...inline, ...regions]) {
    // Progress owns two independent regions; its disclosure and focused summary stay outside both.
    if (group[0] === "s14-pane-live" && document.getElementById("s14-progress-primary") && next.getElementById("s14-progress-primary")) continue;
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
  // The foot of a chat changes only when the Bot can or cannot take a message. A field in use defers the change, and whatever was typed moves across it.
  const dock = document.getElementById("s14-dock"), freshDock = next.getElementById("s14-dock");
  if (dock && freshDock && dock.dataset.sig !== freshDock.dataset.sig) {
    if (busy(dock)) deferred = true;
    else {
      const leaving = dock.querySelector("[data-composer]"), held = leaving ? holdDraft(leaving) : heldDraft;
      dock.innerHTML = freshDock.innerHTML;
      dock.dataset.sig = freshDock.dataset.sig;
      wireComposers();
      const composer = dock.querySelector("[data-composer]"), block = dock.querySelector("[data-draft-held]");
      heldDraft = composer ? null : held;
      if (composer && held) restoreDraft(composer, held);
      if (block && held?.text) {
        block.querySelector("[data-draft-text]").textContent = held.text;
        block.hidden = false;
      }
      if (status) status.textContent = held?.text ? freshDock.dataset.kept : freshDock.dataset.announce;
    }
  }
  const revision = next.querySelector("[data-composer] input[name=expectedRevision]"), mine = document.querySelector("[data-composer] input[name=expectedRevision]");
  if (revision && mine && mine.value !== revision.value) mine.value = revision.value;
  // A pill's glyph is hidden from assistive technology, so the announcement carries the word alone.
  const word = next.querySelector(".s-pane .s-pill, .s-col > .s-between .s-pill");
  word?.querySelector("[aria-hidden]")?.remove();
  const typed = next.querySelector("[data-phase]")?.dataset.phase, phase = typed ?? word?.textContent ?? "";
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

// Browser-local convenience state (ADR 0062). Storage is untrusted; it supplies text, never commands or authority.
const browserState = document.querySelector(".s-app[data-browser-key]");
if (browserState?.dataset.browserKey) {
  const prefix = `jit.s14.draft.${browserState.dataset.browserKey}.`, ttl = 30 * 24 * 60 * 60 * 1000;
  const textNames = ["text", "completion", "evidence"], bounds = [16384, 1000, 8000];
  const sensitive = value => s14DraftCredentialPatterns.some(pattern => pattern.test(value));
  const readDraft = key => {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    if (raw.length > 65536) { localStorage.removeItem(key); return null; }
    let value;
    try { value = JSON.parse(raw); } catch { localStorage.removeItem(key); return null; }
    const keys = Object.keys(value ?? {}).sort().join();
    if (raw.length > 65536 || keys !== "completion,evidence,requestId,text,updatedAt" || !Number.isSafeInteger(value.updatedAt) || value.updatedAt > Date.now() || Date.now() - value.updatedAt >= ttl ||
        !textNames.every((name, index) => typeof value[name] === "string" && value[name].length <= bounds[index] && !sensitive(value[name])) ||
        !(value.requestId === null || typeof value.requestId === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId))) {
      localStorage.removeItem(key); return null;
    }
    return value;
  };
  const prune = () => {
    const live = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("jit.s14.draft.")) {
        if (key.startsWith(prefix)) live.push(key);
        else { localStorage.removeItem(key); i--; }
      }
    }
    for (const key of live) readDraft(key);
  };
  // Explicit logout clears the installation's local drafts; ordinary session expiry does not send or discard them.
  document.querySelector('form[action="/s14/logout"]')?.addEventListener("submit", () => {
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.startsWith("jit.s14.draft.")) localStorage.removeItem(key);
      }
    } catch { /* Storage denial never blocks logout. */ }
  });
  wireBrowserDrafts = () => {
    for (const form of document.querySelectorAll("[data-composer]")) {
      if (form.dataset.draftWired) continue;
      form.dataset.draftWired = "true";
      const conversation = form.elements.namedItem("conversationId")?.value;
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(conversation ?? "")) continue;
      const key = prefix + conversation, status = form.querySelector("[data-draft-status]"), bar = form.querySelector("[data-draft-bar]");
      const field = name => form.elements.namedItem(name);
      const announce = name => {
        if (status && status.textContent !== (status.dataset[name] ?? "")) status.textContent = status.dataset[name] ?? "";
        if (bar) bar.hidden = false;
      };
      const restore = () => {
        try {
          prune();
          const draft = readDraft(key);
          if (!draft) return;
          if (draft.requestId && browserState.dataset.committed === draft.requestId) { localStorage.removeItem(key); return; }
          // A refused server response or an explicit Start prefill wins over a local draft.
          if (form.dataset.refused === "true" || field("text")?.value) return;
          for (const name of textNames) if (field(name)) field(name).value = draft[name];
          if (field("work")) field("work").checked = false;
          syncComposer(form);
          announce("restored");
        } catch { announce("unavailable"); }
      };
      const save = (requestId = null) => {
        const values = Object.fromEntries(textNames.map(name => [name, field(name)?.value ?? ""]));
        try {
          if (textNames.some(name => sensitive(values[name]))) { localStorage.removeItem(key); announce("sensitive"); return; }
          if (textNames.every(name => !values[name].trim())) { localStorage.removeItem(key); if (bar) bar.hidden = true; return; }
          if (!textNames.every((name, index) => values[name].length <= bounds[index])) { announce("unavailable"); return; }
          localStorage.setItem(key, JSON.stringify({ ...values, updatedAt: Date.now(), requestId }));
          announce("saved");
        } catch { announce("unavailable"); }
      };
      let submitted = false;
      restore();
      form.addEventListener("input", () => save());
      form.addEventListener("submit", () => { submitted = true; save(field("requestId")?.value ?? null); });
      form.querySelector("[data-draft-clear]")?.addEventListener("click", () => {
        try { localStorage.removeItem(key); } catch { /* Clearing the visible text still works. */ }
        for (const name of textNames) if (field(name)) field(name).value = "";
        if (field("work")) { field("work").checked = false; field("work").dispatchEvent(new Event("change")); }
        if (bar) bar.hidden = true;
        field("text")?.focus();
      });
      window.addEventListener("pageshow", event => {
        const history = event.persisted || performance.getEntriesByType("navigation")[0]?.type === "back_forward";
        if (!history) return;
        if (submitted) try {
          if (!readDraft(key)) for (const name of textNames) if (field(name)) field(name).value = "";
        } catch { /* An uncertain save retains the visible text. */ }
        if (field("work")) { field("work").checked = false; field("work").dispatchEvent(new Event("change")); }
        restore();
        // Native non-cached history may restore form values after pageshow, so reset after that restoration too.
        if (!event.persisted) setTimeout(() => { if (field("work")) field("work").checked = false; syncComposer(form); }, 0);
      });
    }
  };
  wireBrowserDrafts();
  // Closed Bots can still show their unsent local text without enabling a composer or restoring old choices.
  if (!document.querySelector("[data-composer]") && browserState.dataset.conversation) try {
    prune();
    const draft = readDraft(prefix + browserState.dataset.conversation), held = document.querySelector("[data-draft-held]");
    if (draft && held) { held.querySelector("[data-draft-text]").textContent = draft.text; held.hidden = false; }
  } catch { /* A closed chat remains readable when storage is denied. */ }
  // A cached page's retry IDs, grants, approvals and leases may already be spent. Refresh through a read-only GET.
  window.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  document.querySelector(".s-mobile-nav")?.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      const menu = event.currentTarget;
      menu.open = false; menu.querySelector("summary")?.focus();
    }
  });
}
