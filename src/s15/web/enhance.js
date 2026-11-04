// S15 progressive enhancement (UX15-01, handoff §9 and §11). Every surface works without this script.
// It never submits anything on its own: reconnect and refresh only read; a resend reuses the same request id,
// so the service returns the original receipt. Drafts are browser-local text only, never an approval or rule.
/* global s15CredentialPatterns, s15Motion */
const draftDays = 30;
const doc = document;
let phase = doc.getElementById("s15-phase");
const app = doc.querySelector(".s15-app");
let conversation = app && app.dataset ? app.dataset.conversation || "" : "";
let currentPageUrl = location.href;
// An explicitly submitted composer stays in this tab while its receipt is pending/unknown. Returning to it
// retains that exact request id and continuation, rather than restoring its text into a new command.
const pendingComposers = new Map();

function draftKey(form) { const id = form?.dataset?.conversation || conversation; return id ? `s15-draft:${id}` : ""; }
function sensitive(text) { return typeof s15CredentialPatterns !== "undefined" && s15CredentialPatterns.some(pattern => pattern.test(text)); }
function storage() { try { return globalThis.localStorage || null; } catch { return null; } }
function status(form, name) {
  const bar = form.querySelector("[data-draft-bar]"), line = form.querySelector("[data-draft-status]");
  if (!bar || !line) return;
  bar.hidden = !name; line.textContent = name ? line.dataset[name] || "" : "";
}
function saveDraft(form) {
  const key = draftKey(form), store = storage(), area = form.querySelector("textarea");
  if (!key || !area) return;
  if (!store) { status(form, "unavailable"); return; }
  const text = area.value;
  try {
    if (!text) { store.removeItem(key); status(form, ""); return; }
    if (sensitive(text)) { store.removeItem(key); status(form, "sensitive"); return; }
    store.setItem(key, JSON.stringify({ text, at: Date.now() }));
    status(form, "saved");
  } catch { status(form, "unavailable"); }
}
function restoreDraft(form) {
  const key = draftKey(form), store = storage(), area = form.querySelector("textarea");
  if (!key || !store || !area || area.value) return;
  try {
    const saved = JSON.parse(store.getItem(key) || "null");
    if (!saved || typeof saved.text !== "string" || Date.now() - saved.at > draftDays * 86400000) { store.removeItem(key); return; }
    area.value = saved.text; status(form, "restored");
  } catch { try { store.removeItem(key); } catch {} status(form, "unavailable"); }
}
function clearDraft(form) { const key = draftKey(form), store = storage(); try { if (key && store) store.removeItem(key); status(form, ""); } catch { status(form, "unavailable"); } }

/** Replaces stable regions from a fresh server render. A region holding focus is left alone. */
function swapRegions(fresh, keepComposer) {
  const thread = doc.getElementById("s15-thread"), next = fresh.getElementById("s15-thread");
  if (thread && next) {
    const latest = doc.getElementById("latest");
    for (const row of next.querySelectorAll(".s15-row")) {
      const current = doc.getElementById(row.id);
      if (!current) { if (latest && latest.parentNode === thread) thread.insertBefore(doc.importNode(row, true), latest); else thread.appendChild(doc.importNode(row, true)); announce(row); continue; }
      if (current.dataset.sig === row.dataset.sig || current.contains(doc.activeElement)) continue;
      if (current.dataset.phase !== row.dataset.phase) announce(row);
      current.replaceWith(doc.importNode(row, true));
    }
    const empty = thread.querySelector(".s-empty-thread");
    if (empty && next.querySelector(".s15-row")) empty.remove();
  }
  const composer = doc.getElementById("s15-composer"), fresher = fresh.getElementById("s15-composer");
  if (composer && fresher && !composer.contains(doc.activeElement) && pendingComposers.get(composer.dataset.conversation || conversation) !== composer) {
    const copy = doc.importNode(fresher, true);
    if (keepComposer) {
      // A live refresh keeps what the owner typed and the request id a resend must reuse.
      const area = composer.querySelector("textarea"), freshArea = copy.querySelector("textarea");
      if (area && freshArea) freshArea.value = area.value;
      const id = composer.querySelector("input[name=requestId]"), freshId = copy.querySelector("input[name=requestId]");
      if (id && freshId) freshId.value = id.value;
      // The owner's answer choice belongs to the draft: keep the exact question reference and its checked state.
      const label = composer.querySelector(".s15-answer"), freshLabel = copy.querySelector(".s15-answer");
      if (label) {
        if (freshLabel) freshLabel.replaceWith(label);
        else { const grow = copy.querySelector(".s-bar .s-grow"); if (grow && grow.parentNode) grow.parentNode.insertBefore(label, grow); }
      } else if (freshLabel && area && area.value) {
        // A question that appeared while the owner was typing is offered, never pre-selected for that text.
        const box = freshLabel.querySelector("input[name=answer]"); if (box) box.checked = false;
      }
    }
    composer.replaceWith(copy); wireComposer(copy);
  }
  const live = fresh.querySelector("[data-live]"), scroll = doc.querySelector(".s-scroll");
  if (scroll) { if (live) scroll.setAttribute("data-live", "true"); else scroll.removeAttribute("data-live"); }
  const freshApp = fresh.querySelector(".s15-app");
  if (app && freshApp && freshApp.dataset.cursor) app.dataset.cursor = freshApp.dataset.cursor;
}
/** At most one polite line per phase change; progress lines are never announced one by one. */
function announce(row) {
  if (!phase || !row.dataset) return;
  const word = { working: "working", inspecting: "working", needs_you: "needs", question: "needs", budget_hold: "needs", unknown: "needs", done: "done", partial: "done" }[row.dataset.phase];
  if (word && phase.dataset[word]) phase.textContent = phase.dataset[word];
}
function banner(text) {
  const slot = doc.getElementById("s15-banner"); if (!slot || !text) return;
  slot.innerHTML = '<div class="s-banner" role="status"><div><p><b></b></p></div></div>';
  slot.querySelector("b").textContent = text;
}

async function fetchPage() {
  const response = await fetch(currentPageUrl.split("#")[0], { credentials: "same-origin", cache: "no-store", headers: { Accept: "text/html" } });
  if (!response.ok) throw new Error("refresh_unavailable");
  return new DOMParser().parseFromString(await response.text(), "text/html");
}

function wireComposer(form) {
  if (!form || form.dataset.wired) return;
  form.dataset.wired = "true";
  const area = form.querySelector("textarea");
  restoreDraft(form);
  if (area) {
    let beforeInput = null;
    area.addEventListener("beforeinput", () => { beforeInput = form.getBoundingClientRect?.() || null; });
    area.addEventListener("input", () => { const limit = form.querySelector("[data-quote-limit]"); if (limit) limit.hidden = true; saveDraft(form); s15Motion.layout(form, beforeInput); beforeInput = null; });
    area.addEventListener("keydown", event => {
      // Enter sends; Shift+Enter is a newline; an IME composition Enter never sends.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  }
  const clear = form.querySelector("[data-draft-clear]");
  if (clear) clear.addEventListener("click", () => { if (area) area.value = ""; const limit = form.querySelector("[data-quote-limit]"); if (limit) limit.hidden = true; clearDraft(form); if (area) area.focus(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = "true";
    const submittingConversation = form.dataset.conversation || conversation;
    pendingComposers.set(submittingConversation, form);
    const sending = form.querySelector("[data-sending]"), unknown = form.querySelector("[data-unknown]"), refused = form.querySelector("[data-refused]");
    if (sending) sending.hidden = false; if (unknown) unknown.hidden = true; if (refused) refused.hidden = true;
    // The submitted text is the snapshot being sent; nothing typed meanwhile can be lost when the reply arrives.
    if (area) area.readOnly = true;
    const settle = () => { delete form.dataset.busy; if (sending) sending.hidden = true; if (area) area.readOnly = false; };
    let response, fresh;
    try {
      response = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), credentials: "same-origin", headers: { Accept: "text/html", "X-Jit-Enhanced": "1" } });
      fresh = new DOMParser().parseFromString(await response.text(), "text/html");
    } catch {
      // The receipt is unknown. The same request id stays in the form, so pressing send again cannot duplicate work.
      settle(); if (unknown) unknown.hidden = false; return;
    }
    settle();
    if (pendingComposers.get(submittingConversation) === form) pendingComposers.delete(submittingConversation);
    if (doc.getElementById("s15-composer") !== form) { if (response.ok) clearDraft(form); return; }
    if (!fresh.getElementById("s15-composer")) {
      // A refusal page without a composer (for example an expired session): keep the draft and say why.
      saveDraft(form);
      const signIn = fresh.querySelector("[data-sign-in]");
      if (signIn && signIn.getAttribute("href")) { location.assign(signIn.getAttribute("href")); return; }
      const reason = fresh.querySelector("h1") || fresh.querySelector("[role=alert]");
      if (refused) { refused.textContent = reason && reason.textContent ? reason.textContent : refused.dataset.fallback || ""; refused.hidden = false; }
      return;
    }
    if (response.ok) clearDraft(form);
    // A slow response belongs to the submitting form, never a newly selected conversation.
    const composer = doc.getElementById("s15-composer");
    if (composer && doc.activeElement && composer.contains(doc.activeElement)) doc.activeElement.blur();
    swapRegions(fresh, false);
    const next = doc.getElementById("s15-text"); if (next) next.focus();
    schedule(400);
  });
}

/** Delegated, so chips in rows replaced by a live refresh keep working. */
function onPrefill(event) {
  const chip = event.target && event.target.closest ? event.target.closest("[data-prefill]") : null;
  const area = doc.getElementById("s15-text"); if (!chip || !area) return;
  if (area.readOnly) { event.preventDefault(); return; }
  // A chip only fills the composer with trusted typed text. Nothing is sent until the owner sends it.
  event.preventDefault(); area.value = chip.dataset.prefill; area.focus();
  const form = doc.getElementById("s15-composer"); if (form) saveDraft(form);
}
/** A visible answer can be quoted as data; only the owner's later submit can request execution. */
function onQuote(event) {
  const link = event.target?.closest?.("[data-s15-quote]"), area = doc.getElementById("s15-text");
  if (!link || !area) return;
  if (area.readOnly) { event.preventDefault(); return; }
  const answer = doc.getElementById(`s15-answer-${link.dataset.s15Quote}`); if (!answer) return;
  event.preventDefault();
  const form = doc.getElementById("s15-composer"), before = form?.getBoundingClientRect?.();
  const quoted = [...(answer.textContent || "")].slice(0, 2000).join("").split("\n").map(line => `> ${line}`).join("\n");
  const prefix = `${quoted}\n\n`, limit = form?.querySelector("[data-quote-limit]");
  if (prefix.length + area.value.length > (area.maxLength > 0 ? area.maxLength : 16384)) { if (limit) limit.hidden = false; area.focus(); return; }
  if (limit) limit.hidden = true;
  area.value = `${prefix}${area.value}`; area.focus();
  if (form) { saveDraft(form); s15Motion.layout(form, before); }
}
function wireCopy(root) {
  for (const button of root.querySelectorAll("[data-copy]")) {
    const source = doc.getElementById(button.dataset.copy);
    if (!source || !globalThis.navigator || !navigator.clipboard) continue;
    button.hidden = false;
    button.addEventListener("click", async () => { try { await navigator.clipboard.writeText(source.textContent); button.textContent = button.dataset.copied; } catch {} });
  }
}

let timer = null, offline = false;
function schedule(ms) { if (timer === null && conversation) timer = setTimeout(poll, ms); }
async function poll() {
  timer = null;
  const pollingConversation = conversation, pollingApp = app;
  try {
    const cursor = app && app.dataset.cursor || "0";
    const response = await fetch(`/chats/${conversation}/events?after=${cursor}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (conversation !== pollingConversation || app !== pollingApp) return;
    if (response.status === 409) { const fresh = await fetchPage(); if (conversation !== pollingConversation || app !== pollingApp) return; swapRegions(fresh, true); banner(phase && phase.dataset.reset); if (doc.querySelector("[data-live]")) schedule(2000); return; }
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    if (conversation !== pollingConversation || app !== pollingApp) return;
    if (offline) { offline = false; banner(phase && phase.dataset.reconnected); }
    const count = doc.querySelector("[data-needs-count]");
    if (count && typeof data.needs === "number") count.textContent = data.needs ? String(data.needs) : "";
    if (data.events && data.events.length) { const fresh = await fetchPage(); if (conversation !== pollingConversation || app !== pollingApp) return; swapRegions(fresh, true); }
    // Resume after what was just applied, so a long conversation is never re-read from its first page.
    if (app && typeof data.cursor === "number" && data.cursor > Number(app.dataset.cursor || 0)) app.dataset.cursor = String(data.cursor);
  } catch { offline = true; }
  // Polling stops once no row is live; an offline page keeps retrying until it reconnects.
  if (offline || doc.querySelector("[data-live]")) schedule(offline ? 5000 : 2000);
}

const initial = doc.getElementById("s15-composer");
if (initial) wireComposer(initial);
doc.addEventListener("click", onPrefill); doc.addEventListener("click", onQuote); wireCopy(doc);
if (conversation && doc.querySelector("[data-live]")) schedule(2000);

// UX15-02 (§9): opening a full slip moves focus to its heading, never to a decision button. The takeover view
// moves focus to its bar, whose first control hands back; Esc deliberately does nothing there.
const slipHeading = doc.getElementById("s15-slip-title");
const takeoverBar = doc.getElementById("s15-takeover-bar");
if (takeoverBar) takeoverBar.focus();
else if (slipHeading && !(doc.activeElement && doc.activeElement.closest && doc.activeElement.closest("form"))) slipHeading.focus();
// The protected frame refreshes for the same takeover generation only; a stale generation is refused by the server.
const frame = doc.querySelector(".s15-frame img");
if (frame) {
  const base = frame.getAttribute("src");
  let tick = 0;
  setInterval(() => { tick++; frame.setAttribute("src", `${base}&n=${tick}`); }, 3000);
}
// SETUP15-01: an in-progress working-computer job reloads its own page, but never over something the owner is
// typing elsewhere on it (for example the budget); without script, or once edited, the owner presses refresh.
const provisioning = doc.querySelector("[data-s15-refresh]");
if (provisioning && globalThis.location) {
  let edited = false;
  doc.addEventListener("input", () => { edited = true; });
  const typing = () => { const active = doc.activeElement; return !!active && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName); };
  setTimeout(function again() { if (edited) return; if (typing()) { setTimeout(again, 2000); return; } globalThis.location.reload(); }, Math.max(2, Number(provisioning.dataset.s15Refresh) || 5) * 1000);
}

// Owner-approved premium navigation. Only GETs are enhanced. Every command other than the existing composer
// keeps its native authenticated form POST. No DOM, hidden authority fields or approvals enter history/storage.
(() => {
  if (!app || !doc.documentElement || !doc.createElement || typeof globalThis.URL !== "function" || !globalThis.history) return;
  const detail = doc.getElementById("s15-detail"), search = doc.getElementById("s15-search");
  if (!detail || typeof detail.showModal !== "function") return;
  let navigation = 0, controller = null, closing = 0, detailTarget = "", opener = null;
  const positions = new Map(), selections = new Map();
  const asset = doc.querySelector('script[type="module"][src]')?.getAttribute("src");
  const pagePath = /^(?:\/(?:work|needs|memory|library|models|recovery|setup|search)|\/rules(?:\/recurring)?|\/duties\/[A-Za-z0-9_-]{1,128}|\/chats\/(?:new|[A-Za-z0-9_-]{1,128})|\/resources\/(?:accounts|websites|telegram|computer|github))$/;
  const detailPath = /^\/(?:actions|duties)\/[A-Za-z0-9_-]{1,128}$/;
  const sensitiveView = () => !!doc.querySelector('input[type="password"], #s15-takeover-bar, [data-s15-refresh]');
  const allowed = url => url.origin === location.origin && (pagePath.test(url.pathname) || detailPath.test(url.pathname));
  const currentComposer = () => doc.getElementById("s15-composer");
  const remember = () => {
    const form = currentComposer(), area = form?.querySelector("textarea");
    if (form) saveDraft(form);
    if (area && conversation) selections.set(conversation, { start: area.selectionStart, end: area.selectionEnd });
    const scroll = doc.querySelector(".s-scroll"); if (scroll) positions.set(currentPageUrl, scroll.scrollTop);
  };
  const closeSurface = (restore = true) => {
    const token = ++closing;
    const done = () => { if (token !== closing) return; detail.close(); const body = detail.querySelector("[data-s15-detail-body]"); body.replaceChildren(); body.inert = false; detail.removeAttribute("aria-busy"); detailTarget = ""; if (restore && opener?.isConnected) opener.focus({ preventScroll: true }); };
    if (restore && detail.open) s15Motion.close(detail, done); else { detail.getAnimations?.().forEach(animation => animation.cancel()); done(); }
  };
  const read = async (url, signal) => {
    const response = await fetch(url.href, { signal, credentials: "same-origin", cache: "no-store", headers: { Accept: "text/html", "X-Jit-Enhanced": "1" } });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("text/html")) throw new Error("navigation_unavailable");
    const fresh = new DOMParser().parseFromString(await response.text(), "text/html");
    const next = fresh.querySelector('.s15-app[data-shell-version="premium-v1"]');
    if (!next || fresh.querySelector('script[type="module"][src]')?.getAttribute("src") !== asset || fresh.querySelector('input[type="password"], #s15-takeover-bar, [data-s15-refresh]')) throw new Error("navigation_requires_document");
    const resolved = new URL(response.headers.get("content-location") || response.url || url.href, url.href);
    if (!resolved.hash && url.hash) resolved.hash = url.hash;
    if (!allowed(resolved)) throw new Error("navigation_requires_document");
    return { document: fresh, url: resolved };
  };
  const begin = () => {
    controller?.abort(); controller = new AbortController();
    // Previous exact controls cannot be used while a different detail is being read.
    if (detail.open) { detail.querySelector("[data-s15-detail-body]").inert = true; detail.setAttribute("aria-busy", "true"); }
    return { ticket: ++navigation, signal: controller.signal };
  };
  const restoreSelection = () => {
    const area = currentComposer()?.querySelector("textarea"), saved = selections.get(conversation);
    if (area && saved) area.setSelectionRange(Math.min(saved.start, area.value.length), Math.min(saved.end, area.value.length));
  };
  const focusPage = url => {
    let target = null;
    if (url.hash) { try { target = doc.getElementById(decodeURIComponent(url.hash.slice(1))); } catch {} }
    const scroll = doc.querySelector(".s-scroll");
    if (target) { target.scrollIntoView({ block: "nearest", behavior: "instant" }); target.focus?.({ preventScroll: true }); }
    else { if (scroll) scroll.scrollTop = positions.get(url.href) || 0; const main = doc.getElementById("main-content"); main.setAttribute("tabindex", "-1"); main.focus({ preventScroll: true }); }
  };
  async function navigatePage(url, push = true) {
    remember(); const { ticket, signal } = begin();
    try {
      const loaded = await read(url, signal); if (ticket !== navigation) return;
      const fresh = loaded.document; url = loaded.url;
      // Server-sensitive destinations retain native lifecycle and input custody.
      if (sensitiveView()) { location.assign(url.href); return; }
      closeSurface(false); search.close();
      const previousConversation = conversation, previousText = currentComposer()?.querySelector("textarea")?.value || "";
      await s15Motion.run(() => {
        if (ticket !== navigation) return;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        const nextApp = fresh.querySelector(".s15-app");
        doc.getElementById("main-content").replaceWith(doc.importNode(fresh.getElementById("main-content"), true));
        const sidebar = doc.querySelector(".s15-app > .s-nav"), nextSidebar = nextApp.querySelector(":scope > .s-nav");
        if (sidebar && nextSidebar) sidebar.replaceWith(doc.importNode(nextSidebar, true));
        for (const name of ["conversation", "cursor"]) { delete app.dataset[name]; if (nextApp.dataset[name]) app.dataset[name] = nextApp.dataset[name]; }
        conversation = app.dataset.conversation || "";
        for (const id of ["s15-phase", "s15-needs-live"]) { const old = doc.getElementById(id), next = fresh.getElementById(id); if (old && next) old.replaceWith(doc.importNode(next, true)); }
        phase = doc.getElementById("s15-phase");
        search.innerHTML = fresh.getElementById("s15-search").innerHTML;
        const freshForm = currentComposer(), pending = pendingComposers.get(conversation);
        if (freshForm && pending) freshForm.replaceWith(pending);
        const form = currentComposer(), area = form?.querySelector("textarea");
        if (area && conversation === previousConversation && !area.value && previousText && !url.search) area.value = previousText;
        if (form) wireComposer(form);
        wireCopy(doc.getElementById("main-content")); restoreSelection();
        currentPageUrl = url.href; doc.title = fresh.title; doc.documentElement.lang = fresh.documentElement.lang;
        if (push) history.pushState({ s15: true }, "", url.href);
        focusPage(url); if (conversation && doc.querySelector("[data-live]")) schedule(400);
      });
      return ticket === navigation;
    } catch (error) { if (error.name !== "AbortError" && ticket === navigation) location.assign(url.href); }
  }
  async function openDetail(url, push = true, depth = 1) {
    const { ticket, signal } = begin();
    try {
      const loaded = await read(url, signal); if (ticket !== navigation) return;
      const fresh = loaded.document; url = loaded.url;
      if (sensitiveView()) { location.assign(url.href); return; }
      const body = detail.querySelector("[data-s15-detail-body]"), next = fresh.querySelector(".s-scroll");
      const existing = detail.open; ++closing; detail.getAnimations?.().forEach(animation => animation.cancel());
      if (!existing) opener = doc.activeElement;
      if (detailTarget) positions.set(detailTarget, detail.scrollTop);
      body.replaceChildren(...[...next.childNodes].map(node => doc.importNode(node, true)));
      // Overlay IDs cannot collide with an underlying responsibility or evidence row. This changes labels only,
      // never form names, CSRF, action revisions, hashes or command data.
      const ids = new Map();
      for (const element of body.querySelectorAll("[id]")) { const original = element.id; element.dataset.s15OriginalId = original; element.id = `s15-detail-${ticket}-${original}`; ids.set(original, element.id); }
      for (const element of body.querySelectorAll("*")) {
        for (const name of ["for", "aria-labelledby", "aria-describedby", "aria-controls", "data-copy"]) { const value = element.getAttribute(name); if (value) element.setAttribute(name, value.split(" ").map(id => ids.get(id) || id).join(" ")); }
        const href = element.getAttribute("href"); if (href?.startsWith("#") && ids.has(href.slice(1))) element.setAttribute("href", `#${ids.get(href.slice(1))}`);
      }
      const slipTitle = fresh.getElementById("s15-slip-title");
      detail.dataset.s15Presentation = slipTitle ? "approval" : "detail";
      const title = slipTitle || fresh.querySelector(".s-hdr h1");
      body.inert = false; detail.removeAttribute("aria-busy");
      detail.querySelector("#s15-detail-title").textContent = title?.textContent || "";
      const fullPage = detail.querySelector("[data-s15-detail-page]"); fullPage.setAttribute("href", url.href);
      detail.querySelector("[data-s15-detail-back]").hidden = false;
      if (!existing) detail.showModal();
      detail.scrollTop = positions.get(url.href) || 0;
      const heading = body.querySelector('[data-s15-original-id="s15-slip-title"]') || detail.querySelector("#s15-detail-title"); heading.focus({ preventScroll: true });
      detailTarget = url.href; search.close(); wireCopy(body);
      if (push) history.pushState({ s15: true, detail: url.href, depth }, "", currentPageUrl);
      s15Motion.enter(existing ? body : detail, !push);
    } catch (error) { if (error.name !== "AbortError" && ticket === navigation) location.assign(url.href); }
  }
  const closeDetails = () => {
    if (history.state?.detail && history.state.depth > 0) history.go(-history.state.depth);
    else closeSurface();
  };
  doc.addEventListener("click", event => {
    const close = event.target.closest?.("[data-s15-close]");
    if (close) { event.preventDefault(); if (close.closest("#s15-search")) search.close(); else closeDetails(); return; }
    if (event.target.closest?.("[data-s15-detail-back]")) { event.preventDefault(); history.back(); return; }
    const searchButton = event.target.closest?.("[data-s15-search]");
    if (searchButton) { if (sensitiveView()) return; event.preventDefault(); if (detail.open) return; opener = searchButton; search.showModal(); s15Motion.enter(search); search.querySelector("input").focus(); return; }
    const link = event.target.closest?.("a[href]");
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.hasAttribute("download") || (link.target && link.target !== "_self") || link.hasAttribute("data-s15-detail-page") || sensitiveView()) return;
    const url = new URL(link.href, location.href);
    if (!allowed(url) || (url.pathname === location.pathname && url.search === location.search && url.hash && !detail.open)) return;
    event.preventDefault();
    const base = new URL(currentPageUrl);
    const isDetail = detailPath.test(url.pathname) || (url.pathname === "/library" && url.searchParams.has("request"));
    const baseIsDetail = detailPath.test(base.pathname) || (base.pathname === "/library" && base.searchParams.has("request"));
    if (isDetail && !baseIsDetail) openDetail(url, true, detail.open ? (history.state?.depth || 1) + 1 : 1);
    else navigatePage(url);
  });
  doc.addEventListener("input", event => {
    if (event.target.id !== "s15-search-input") return;
    const query = event.target.value.trim().toLocaleLowerCase(); let count = 0;
    for (const link of search.querySelectorAll(".s15-search-results a")) { link.hidden = !link.textContent.toLocaleLowerCase().includes(query); if (!link.hidden) count++; }
    search.querySelector("#s15-search-empty").hidden = count > 0;
  });
  doc.addEventListener("keydown", event => {
    if (event.key === "Escape" && search.open) { event.preventDefault(); search.close(); return; }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !detail.open && !sensitiveView()) { event.preventDefault(); if (search.open) search.close(); else { search.showModal(); search.querySelector("input").focus(); } }
  });
  detail.addEventListener("cancel", event => { event.preventDefault(); closeDetails(); });
  globalThis.addEventListener("popstate", async () => {
    remember();
    const entry = history.state, base = new URL(location.href);
    if (entry?.detail) {
      const url = new URL(entry.detail, base);
      if (allowed(url)) {
        if (base.href !== currentPageUrl) {
          if (!await navigatePage(base, false)) return;
          if (location.href !== base.href || history.state?.detail !== entry.detail || history.state?.depth !== entry.depth) return;
        }
        openDetail(url, false, entry.depth || 1); return;
      }
    }
    if (location.href === currentPageUrl) { begin(); closeSurface(); return; }
    navigatePage(new URL(location.href), false);
  });
  // Browser page-cache restoration must not revive a spent approval, hidden revision or takeover input lease.
  globalThis.addEventListener("pageshow", event => { if (event.persisted) location.reload(); });
  history.replaceState({ s15: true }, "", location.href);
  if (globalThis.visualViewport) {
    const fitKeyboard = () => { if (currentComposer()?.contains(doc.activeElement)) app.style.height = `${Math.min(innerHeight, visualViewport.height)}px`; else app.style.removeProperty("height"); };
    visualViewport.addEventListener("resize", fitKeyboard); doc.addEventListener("focusout", () => queueMicrotask(fitKeyboard));
  }
})();
