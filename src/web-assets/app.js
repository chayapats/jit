// Jit browser enhancements (ADR 0028). Hand-written ES module, no dependencies, no build step.
// Every page is complete without this file. It adds behaviour only: it never posts data itself and
// never stores owner content (the service worker it registers caches only static assets). Forms still submit
// through the normal form post (the setup ceremony only delays its own form's submit to play the animation).
// The only reads it makes are two same-origin GETs that already work as pages: the topic panel page and the
// bounded ⌘K query.

const root = document.documentElement;
root.dataset.enhanced = "true";
const palette = document.getElementById("palette");
/** Same-origin absolute path only: never a scheme, host or protocol-relative URL (`//x` or `/\x`). */
const localPath = href => typeof href === "string" && /^\/(?![\/\\])/.test(href) && !/[\u0000-\u001f]/.test(href);

// Static-only PWA (web.pwa/v1). The worker caches only the hashed stylesheet, scripts, fonts and icons; pages and data
// always come from the network. Browsers allow workers only in a secure context (HTTPS or localhost).
if (globalThis.isSecureContext && globalThis.navigator?.serviceWorker?.register) {
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {});
}

// Sidebar drawer (mobile). Without script, the menu link targets #sidebar and CSS :target opens it.
const app = document.querySelector(".app");
const sidebar = document.getElementById("sidebar");
const menuButton = document.querySelector(".menu-button");
if (app && sidebar && menuButton) {
  const setOpen = (open, focus = true) => {
    app.dataset.drawer = open ? "open" : "closed";
    menuButton.setAttribute("aria-expanded", String(open));
    // Drop a #sidebar fragment so the CSS :target fallback cannot reopen or contradict the script state.
    if (!open && location.hash === "#sidebar") history.replaceState(null, "", location.pathname + location.search);
    if (!focus) return;
    if (open) sidebar.querySelector("a, button")?.focus();
    else menuButton.focus();
  };
  // The drawer may already be open through the no-script #sidebar target (refresh, direct link, early tap).
  setOpen(location.hash === "#sidebar", false);
  // Back/forward and in-page links change the fragment; follow it in both directions.
  window.addEventListener("hashchange", () => setOpen(location.hash === "#sidebar", location.hash === "#sidebar"));
  menuButton.addEventListener("click", event => { event.preventDefault(); setOpen(app.dataset.drawer !== "open"); });
  for (const close of document.querySelectorAll(".drawer-close, .drawer-scrim")) {
    close.addEventListener("click", event => { event.preventDefault(); setOpen(false); });
  }
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && app.dataset.drawer === "open" && !palette?.open) setOpen(false);
  });
}

// Composer: Enter submits through the form's own post (Shift+Enter keeps a new line, and an IME composition
// such as Thai input is never interrupted); ⌘/Ctrl+Enter also submits. The textarea grows with its content.
for (const textarea of document.querySelectorAll(".composer textarea")) {
  const form = textarea.form;
  textarea.addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.isComposing || event.keyCode === 229) return;
    if (event.shiftKey && !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    if (form?.reportValidity()) form.requestSubmit();
  });
  if (!CSS.supports("field-sizing", "content")) {
    const grow = () => { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`; };
    textarea.addEventListener("input", grow);
    grow();
  }
}

// ตั้งจิต ceremony (app.setup/v1): the halo draws in, then the dot rises and settles, then the final setup form posts
// as usual. Without script, or under prefers-reduced-motion, the form simply submits with no animation.
const ceremony = document.querySelector("[data-ceremony]");
const ceremonyForm = document.querySelector("form[data-ceremony-form]");
if (ceremony && ceremonyForm) {
  ceremonyForm.addEventListener("submit", event => {
    if (ceremony.dataset.ceremony === "playing" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    event.preventDefault();
    ceremony.dataset.ceremony = "playing";
    ceremonyForm.querySelector("button")?.setAttribute("aria-disabled", "true");
    const ms = Number(ceremony.dataset.ceremonyMs);
    // HTMLFormElement.submit() posts the same fields without firing this handler again.
    window.setTimeout(() => ceremonyForm.submit(), Number.isFinite(ms) && ms > 0 && ms <= 5000 ? ms : 1600);
  });
}

// Jit replies (web.reply_stream/v2): durable state carries replay IDs; preview snapshots are memory-only.
// Every snapshot replaces the previous one, including after reconnect. Text always uses textContent.
// The stream never starts work. Without this script the placeholder's refresh link shows the same state.
// The view follows the stream only while the owner is at the bottom. The draft is not a live region: one polite status
// line per card announces a change of phase (replying, still working, connection, finished), never a token.
// The server ends every connection after a bounded lifetime, so reconnects are routine: the draft stays, and only a gap
// longer than the grace period dims it and shows a calm hint. After a reconnect, a draft no snapshot confirms is cleared.
const chat = document.querySelector("[data-reply-stream]");
if (chat && typeof EventSource === "function") {
  const live = new Set(["thinking", "queued", "blocked"]);
  const graceMs = 3000;
  const base = chat.dataset.replyStream;
  const stream = new EventSource(`${base}${base.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(chat.dataset.replyCursor ?? "0")}`);
  const show = (node, text) => { if (!node) return; node.textContent = text ?? ""; node.hidden = !text; };
  const previewVersions = new Map(), unconfirmed = new Set();
  let grace = 0, confirmation = 0, disconnected = false;
  const stopGrace = () => { if (grace) window.clearTimeout(grace); grace = 0; };
  const stopConfirmation = () => { if (confirmation) window.clearTimeout(confirmation); confirmation = 0; };
  const region = chat.closest?.(".scroll-region") ?? null;
  // Pinned while the owner is within a few lines of the end; scrolling up stops the follow until they come back.
  const follow = update => {
    const pinned = region !== null && region.scrollHeight - region.scrollTop - region.clientHeight <= 48;
    update();
    if (pinned) region.scrollTop = region.scrollHeight;
  };
  const announce = (card, text) => { const node = card.querySelector("[data-reply-announce]"); if (node && text) node.textContent = text; };
  const liveCards = () => [...document.querySelectorAll("[data-reply-id]")].filter(card => live.has(card.dataset.replyState));
  // null hides the hint; "reconnecting" and "closed" pick its server-localised text from the hint's data attributes.
  const gap = (card, state) => {
    const node = card.querySelector("[data-reply-connection]");
    if (!state) { delete card.dataset.replyGap; if (node) node.hidden = true; return; }
    if (card.dataset.replyGap === state) return;
    card.dataset.replyGap = state;
    if (!node) return;
    node.textContent = node.dataset[state] ?? node.textContent;
    node.hidden = false;
    announce(card, node.textContent);
  };
  // S12-D08 reply chips: the page puts a hidden slot of ready forms (each with its own request id) after the newest live
  // reply. Chips the service allowed for that answer fill it once nothing else is live; text goes in through
  // value/textContent only, and a tap is the same plain form post as without script.
  const pendingChips = new Map();
  const fillChips = (id, replies) => {
    const slot = document.querySelector(`[data-reply-chips="${id}"]`);
    if (!slot) return;
    let shown = 0;
    for (const [index, form] of [...slot.querySelectorAll("form")].entries()) {
      const text = replies[index], input = form.querySelector('input[name="text"]'), button = form.querySelector("button");
      if (typeof text !== "string" || !text || !input || !button) { form.remove(); continue; }
      input.value = text; button.textContent = text; form.hidden = false; shown++;
    }
    slot.hidden = shown === 0;
  };
  const clearDraft = card => {
    show(card.querySelector("[data-reply-progress]"), "");
    const provisional = card.querySelector("[data-reply-provisional]");
    if (provisional) provisional.hidden = true;
    delete card.dataset.replyPhase;
  };
  stream.addEventListener("reply-preview", event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data.id !== "string" || !/^[a-f0-9-]{36}$/.test(data.id) ||
      typeof data.attemptId !== "string" || !/^[a-f0-9-]{36}$/.test(data.attemptId) ||
      !Number.isSafeInteger(data.sequence) || data.sequence < 0 || typeof data.text !== "string" || data.text.length > 32768) return;
    const card = document.getElementById(`reply-${data.id}`);
    if (!card || card.dataset.replyState !== "thinking") return;
    const previous = previewVersions.get(data.id);
    if (previous?.attemptId === data.attemptId && previous.sequence > data.sequence) return;
    previewVersions.set(data.id, { attemptId: data.attemptId, sequence: data.sequence });
    unconfirmed.delete(data.id);
    gap(card, null);
    follow(() => {
      show(card.querySelector("[data-reply-progress]"), data.text);
      const provisional = card.querySelector("[data-reply-provisional]");
      if (provisional) provisional.hidden = !data.text;
      const label = card.querySelector("[data-reply-label]");
      if (label) label.textContent = data.label ?? "";
    });
    const phase = data.stalled === true ? "stalled" : data.text ? "streaming" : "thinking";
    if (card.dataset.replyPhase === phase) return;
    card.dataset.replyPhase = phase;
    if (phase !== "thinking") announce(card, data.label);
  });
  stream.addEventListener("error", () => {
    for (const id of previewVersions.keys()) unconfirmed.add(id);
    previewVersions.clear();
    stopConfirmation();
    const firstDisconnect = !disconnected;
    disconnected = true;
    // CLOSED (2): the browser will not retry (refused, signed out or over the reader limit), so point to Refresh now.
    if (stream.readyState === 2) { for (const card of liveCards()) gap(card, "closed"); return; }
    // Retry failures belong to the same outage; only a successful open resets its deadline.
    if (firstDisconnect) grace = window.setTimeout(() => {
      grace = 0;
      if (stream.readyState !== 2) for (const card of liveCards()) gap(card, "reconnecting");
    }, graceMs);
  });
  stream.addEventListener("open", () => {
    stopGrace();
    stopConfirmation();
    disconnected = false;
    for (const card of liveCards()) gap(card, null);
    if (!unconfirmed.size) return;
    // A reconnect receives every current snapshot at once; a draft none confirms belongs to an attempt that has ended.
    confirmation = window.setTimeout(() => {
      for (const id of unconfirmed) {
        const card = document.getElementById(`reply-${id}`);
        if (card?.dataset.replyState === "thinking") follow(() => clearDraft(card));
      }
      unconfirmed.clear();
      confirmation = 0;
    }, graceMs);
  });
  stream.addEventListener("reply", event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data.id !== "string" || !/^[a-f0-9-]{36}$/.test(data.id)) return;
    const card = document.getElementById(`reply-${data.id}`);
    if (!card) return;
    const changed = card.dataset.replyState !== data.state;
    unconfirmed.delete(data.id);
    gap(card, null);
    // The committed text takes the draft's place with the same typography; the unsaved line becomes the saved line.
    follow(() => {
      card.dataset.replyState = data.state;
      const label = card.querySelector("[data-reply-label]");
      if (label) { label.textContent = data.label ?? ""; label.dataset.state = data.tone ?? ""; }
      const avatar = card.querySelector("[data-reply-avatar]");
      if (avatar) { if (data.state === "thinking") avatar.dataset.state = "thinking"; else delete avatar.dataset.state; }
      if (data.state !== "thinking" || !previewVersions.has(data.id)) {
        show(card.querySelector("[data-reply-progress]"), data.progress?.text);
        const provisional = card.querySelector("[data-reply-provisional]");
        if (provisional) provisional.hidden = !data.progress;
      }
      if (data.state !== "thinking") { previewVersions.delete(data.id); delete card.dataset.replyPhase; }
      const saved = card.querySelector("[data-reply-saved]");
      if (saved) saved.hidden = data.state !== "answered";
      show(card.querySelector("[data-reply-next]"), data.next);
      show(card.querySelector("[data-reply-text]"), data.state === "answered" ? data.text : "");
      // app.role_proposals/v1: cards render on the page itself; an answered reply that carries one shows the link to it.
      const proposals = card.querySelector("[data-reply-proposals]");
      if (proposals) proposals.hidden = !(data.state === "answered" && Number.isSafeInteger(data.proposals) && data.proposals > 0);
      if (!live.has(data.state)) card.querySelector("[data-reply-stop]")?.remove();
    });
    if (changed && data.state !== "thinking") {
      announce(card, data.state === "answered" ? card.querySelector("[data-reply-announce]")?.dataset.answered : [data.label, data.next].filter(Boolean).join(" "));
    }
    if (data.state === "answered" && Array.isArray(data.suggestions) && data.suggestions.length) pendingChips.set(data.id, data.suggestions);
    if (!liveCards().length) {
      if (pendingChips.size) follow(() => { for (const [id, replies] of pendingChips) fillChips(id, replies); pendingChips.clear(); });
      stopGrace(); stopConfirmation(); stream.close();
    }
  });
}

// Topic right panel (web.settings_ia/v1). Closed by default. Without script the toggle and the tabs are links to
// the panel page; here the same page is fetched and only its `.panel-body` is shown in the aside.
const panel = document.getElementById("topic-panel");
const panelToggle = document.querySelector(".panel-toggle");
if (app && panel && panelToggle) {
  let shown = null, ticket = 0;
  const setPanel = (open, focus = true) => {
    panel.hidden = !open;
    app.dataset.panel = open ? "open" : "closed";
    panelToggle.setAttribute("aria-expanded", String(open));
    if (!focus) return;
    if (open) panel.querySelector("#topic-panel-title")?.focus();
    else panelToggle.focus();
  };
  // Loads one panel page; on any failure the browser opens that page instead, which is the no-script path.
  const load = async href => {
    if (!localPath(href)) return false;
    const mine = ++ticket;
    panel.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(href, { credentials: "same-origin", headers: { accept: "text/html" } });
      if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("text/html")) throw new Error("panel unavailable");
      const body = new DOMParser().parseFromString(await response.text(), "text/html").querySelector(".panel-body");
      if (!body) throw new Error("panel unavailable");
      if (mine !== ticket) return false;
      panel.replaceChildren(document.adoptNode(body));
      shown = href;
      return true;
    } catch {
      if (mine === ticket) location.assign(href);
      return false;
    } finally {
      if (mine === ticket) panel.removeAttribute("aria-busy");
    }
  };
  setPanel(false, false);
  panelToggle.addEventListener("click", async event => {
    event.preventDefault();
    if (!panel.hidden) return setPanel(false);
    if (shown || await load(panelToggle.getAttribute("href"))) setPanel(true);
  });
  panel.addEventListener("click", async event => {
    const link = event.target?.closest?.("a");
    if (!link) return;
    if (link.classList.contains("panel-close")) { event.preventDefault(); return setPanel(false); }
    const tab = link.dataset.panelTab;
    if (!tab) return;
    event.preventDefault();
    if (await load(link.getAttribute("href"))) panel.querySelector(`[data-panel-tab="${tab}"]`)?.focus();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !panel.hidden && !palette?.open) setPanel(false);
  });
}

// Live view of the project box (web.box_live/v1). The page is complete without this script: the image shows,
// the Refresh link reloads and every takeover control is a plain form post (forms are never intercepted here).
// With script, the image swaps to the latest screenshot every second while the page is visible; hidden pages
// stop polling. The latest id comes from the page's own JSON endpoint next to the screenshot URL.
const live = document.querySelector('img[data-live-refresh], input[type="image"][data-live-refresh]');
// Duck-typed (no HTMLImageElement): the contract harness evaluates this file with a stub DOM.
if (live && typeof fetch === "function" && typeof live.dataset?.liveLatest === "string") {
  const latestUrl = live.dataset.liveLatest;
  const shotBase = live.currentSrc || live.src;
  const prefix = shotBase.slice(0, Math.max(0, shotBase.lastIndexOf("/")));
  let timer = 0, current = shotBase;
  const poll = async () => {
    if (document.visibilityState !== "visible" || typeof latestUrl !== "string" || !localPath(new URL(latestUrl, location.origin).pathname)) return;
    try {
      const response = await fetch(latestUrl, { credentials: "same-origin", headers: { accept: "application/json" } });
      if (!response.ok) return;
      const body = await response.json();
      const id = typeof body?.id === "string" && /^[a-f0-9-]{36}$/.test(body.id) ? body.id : null;
      if (!id) return;
      const next = `${prefix}/${id}`;
      if (next !== current) { current = next; live.src = next; }
    } catch { /* The next tick retries; the Refresh link still works. */ }
  };
  const restart = () => {
    window.clearInterval(timer);
    if (document.visibilityState === "visible") timer = window.setInterval(poll, 1000);
  };
  document.addEventListener("visibilitychange", restart);
  restart();
}

// ⌘K / Ctrl+K palette (web.settings_ia/v1). Without script the sidebar search link opens /search. Results come
// from one bounded server query per pause in typing; nothing is preloaded or kept. Owner text enters the page
// only through textContent. Enter opens the active row; with no active row the form submits to /search.
if (palette && typeof palette.showModal === "function") {
  const input = palette.querySelector("#palette-query");
  const list = palette.querySelector("#palette-results");
  const status = palette.querySelector(".palette-status");
  let options = [], active = -1, timer = 0, ticket = 0, controller = null, opener = null;
  const kindLabel = kind => palette.dataset[`kind${kind.charAt(0).toUpperCase()}${kind.slice(1)}`] ?? "";
  // index < 0 or no rows clears the active row; otherwise the index wraps around the list.
  const setActive = index => {
    active = options.length && index >= 0 ? index % options.length : -1;
    options.forEach((option, i) => option.setAttribute("aria-selected", String(i === active)));
    if (active < 0) return input.removeAttribute("aria-activedescendant");
    input.setAttribute("aria-activedescendant", options[active].id);
    options[active].scrollIntoView?.({ block: "nearest" });
  };
  const go = href => {
    if (!localPath(href)) return;
    palette.close();
    location.assign(href);
  };
  const render = (items, more) => {
    options = items.filter(item => item && localPath(item.href) && typeof item.label === "string").map((item, index) => {
      const option = document.createElement("li");
      option.id = `palette-option-${index}`;
      option.setAttribute("role", "option");
      option.dataset.href = item.href;
      const kind = document.createElement("span"), label = document.createElement("span");
      kind.className = "palette-kind"; kind.textContent = kindLabel(String(item.kind));
      label.className = "palette-label"; label.textContent = item.label;
      option.append(kind, label);
      if (typeof item.detail === "string") {
        const detail = document.createElement("span");
        detail.className = "palette-detail"; detail.textContent = item.detail;
        option.append(detail);
      }
      option.addEventListener("click", () => go(option.dataset.href));
      return option;
    });
    list.replaceChildren(...options);
    input.setAttribute("aria-expanded", String(options.length > 0));
    status.textContent = !options.length ? palette.dataset.empty : more ? palette.dataset.more : "";
    setActive(options.length ? 0 : -1);
  };
  const search = async () => {
    const mine = ++ticket;
    controller?.abort();
    controller = new AbortController();
    status.textContent = palette.dataset.loading;
    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(input.value)}`, { credentials: "same-origin", headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) throw new Error("search unavailable");
      const body = await response.json();
      if (mine === ticket) render(Array.isArray(body?.items) ? body.items : [], body?.more === true);
    } catch (error) {
      if (mine !== ticket || error?.name === "AbortError") return;
      options = []; list.replaceChildren(); setActive(-1);
      input.setAttribute("aria-expanded", "false");
      status.textContent = palette.dataset.error;
    }
  };
  const open = () => {
    if (palette.open) return;
    opener = document.activeElement;
    palette.showModal();
    input.value = "";
    input.focus();
    search();
  };
  palette.addEventListener("close", () => {
    window.clearTimeout(timer);
    ticket++;
    controller?.abort();
    const back = opener;
    opener = null;
    back?.focus?.();
  });
  input.addEventListener("input", () => {
    // Rows on screen belong to the previous query: Enter must not open them while the new one is pending.
    ticket++;
    setActive(-1);
    window.clearTimeout(timer);
    timer = window.setTimeout(search, 120);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(event.key === "ArrowDown" ? active + 1 : (active < 0 ? 0 : active) - 1 + options.length);
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      go(options[active].dataset.href);
    }
  });
  document.addEventListener("keydown", event => {
    // event.code keeps the shortcut on the physical K key under non-Latin layouts such as Thai Kedmanee.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && (event.code === "KeyK" || event.key?.toLowerCase() === "k")) {
      event.preventDefault();
      if (palette.open) palette.close();
      else open();
    }
  });
  document.querySelector(".nav-search")?.addEventListener("click", event => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button) return;
    event.preventDefault();
    open();
  });
  // A click on the backdrop (the dialog element itself, outside its content) closes the palette.
  palette.addEventListener("click", event => { if (event.target === palette) palette.close(); });
}
