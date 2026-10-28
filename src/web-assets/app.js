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

// Jit replies (app.jit_reply/v1): follow the topic's event stream and update each reply placeholder in place.
// Events carry persisted state and server-localised labels; text is set with textContent only, never as markup.
// The stream never starts work. Without this script the placeholder's refresh link shows the same state.
const chat = document.querySelector("[data-reply-stream]");
if (chat && typeof EventSource === "function") {
  const live = new Set(["thinking", "blocked"]);
  const base = chat.dataset.replyStream;
  const stream = new EventSource(`${base}${base.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(chat.dataset.replyCursor ?? "0")}`);
  const show = (node, text) => { if (!node) return; node.textContent = text ?? ""; node.hidden = !text; };
  stream.addEventListener("reply", event => {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (!data || typeof data.id !== "string" || !/^[a-f0-9-]{36}$/.test(data.id)) return;
    const card = document.getElementById(`reply-${data.id}`);
    if (!card) return;
    card.dataset.replyState = data.state;
    const label = card.querySelector("[data-reply-label]");
    if (label) { label.textContent = data.label ?? ""; label.dataset.state = data.tone ?? ""; }
    const avatar = card.querySelector("[data-reply-avatar]");
    if (avatar) { if (data.state === "thinking") avatar.dataset.state = "thinking"; else delete avatar.dataset.state; }
    show(card.querySelector("[data-reply-progress]"), data.progress?.text);
    const provisional = card.querySelector("[data-reply-provisional]");
    if (provisional) provisional.hidden = !data.progress;
    show(card.querySelector("[data-reply-next]"), data.next);
    show(card.querySelector("[data-reply-text]"), data.state === "answered" ? data.text : "");
    // app.role_proposals/v1: cards render on the page itself; an answered reply that carries one shows the link to it.
    const proposals = card.querySelector("[data-reply-proposals]");
    if (proposals) proposals.hidden = !(data.state === "answered" && Number.isSafeInteger(data.proposals) && data.proposals > 0);
    if (!live.has(data.state)) card.querySelector("[data-reply-stop]")?.remove();
    if (![...document.querySelectorAll("[data-reply-id]")].some(node => live.has(node.dataset.replyState))) stream.close();
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
