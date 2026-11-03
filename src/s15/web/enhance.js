// S15 progressive enhancement (UX15-01, handoff §9 and §11). Every surface works without this script.
// It never submits anything on its own: reconnect and refresh only read; a resend reuses the same request id,
// so the service returns the original receipt. Drafts are browser-local text only, never an approval or rule.
/* global s15CredentialPatterns */
const draftDays = 30;
const doc = document;
const phase = doc.getElementById("s15-phase");
const app = doc.querySelector(".s15-app");
const conversation = app && app.dataset ? app.dataset.conversation || "" : "";

function draftKey() { return conversation ? `s15-draft:${conversation}` : ""; }
function sensitive(text) { return typeof s15CredentialPatterns !== "undefined" && s15CredentialPatterns.some(pattern => pattern.test(text)); }
function storage() { try { return globalThis.localStorage || null; } catch { return null; } }
function status(form, name) {
  const bar = form.querySelector("[data-draft-bar]"), line = form.querySelector("[data-draft-status]");
  if (!bar || !line) return;
  bar.hidden = !name; line.textContent = name ? line.dataset[name] || "" : "";
}
function saveDraft(form) {
  const key = draftKey(), store = storage(), area = form.querySelector("textarea");
  if (!key || !store || !area) return;
  const text = area.value;
  if (!text) { store.removeItem(key); status(form, ""); return; }
  if (sensitive(text)) { store.removeItem(key); status(form, "sensitive"); return; }
  store.setItem(key, JSON.stringify({ text, at: Date.now() }));
  status(form, "saved");
}
function restoreDraft(form) {
  const key = draftKey(), store = storage(), area = form.querySelector("textarea");
  if (!key || !store || !area || area.value) return;
  try {
    const saved = JSON.parse(store.getItem(key) || "null");
    if (!saved || typeof saved.text !== "string" || Date.now() - saved.at > draftDays * 86400000) { store.removeItem(key); return; }
    area.value = saved.text; status(form, "restored");
  } catch { store.removeItem(key); }
}
function clearDraft(form) { const key = draftKey(), store = storage(); if (key && store) store.removeItem(key); status(form, ""); }

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
  if (composer && fresher && !composer.contains(doc.activeElement)) {
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
  const response = await fetch(location.href.split("#")[0], { credentials: "same-origin", headers: { Accept: "text/html" } });
  return new DOMParser().parseFromString(await response.text(), "text/html");
}

function wireComposer(form) {
  if (!form || form.dataset.wired) return;
  form.dataset.wired = "true";
  const area = form.querySelector("textarea");
  restoreDraft(form);
  if (area) {
    area.addEventListener("input", () => saveDraft(form));
    area.addEventListener("keydown", event => {
      // Enter sends; Shift+Enter is a newline; an IME composition Enter never sends.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.dispatchEvent(new Event("submit", { cancelable: true }));
    });
  }
  const clear = form.querySelector("[data-draft-clear]");
  if (clear) clear.addEventListener("click", () => { if (area) area.value = ""; clearDraft(form); if (area) area.focus(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = "true";
    const sending = form.querySelector("[data-sending]"), unknown = form.querySelector("[data-unknown]"), refused = form.querySelector("[data-refused]");
    if (sending) sending.hidden = false; if (unknown) unknown.hidden = true; if (refused) refused.hidden = true;
    // The submitted text is the snapshot being sent; nothing typed meanwhile can be lost when the reply arrives.
    if (area) area.readOnly = true;
    const settle = () => { delete form.dataset.busy; if (sending) sending.hidden = true; if (area) area.readOnly = false; };
    let response, fresh;
    try {
      response = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), credentials: "same-origin", headers: { Accept: "text/html" } });
      fresh = new DOMParser().parseFromString(await response.text(), "text/html");
    } catch {
      // The receipt is unknown. The same request id stays in the form, so pressing send again cannot duplicate work.
      settle(); if (unknown) unknown.hidden = false; return;
    }
    settle();
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
  // A chip only fills the composer with trusted typed text. Nothing is sent until the owner sends it.
  event.preventDefault(); area.value = chip.dataset.prefill; area.focus();
  const form = doc.getElementById("s15-composer"); if (form) saveDraft(form);
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
  try {
    const cursor = app && app.dataset.cursor || "0";
    const response = await fetch(`/chats/${conversation}/events?after=${cursor}`, { credentials: "same-origin", headers: { Accept: "application/json" } });
    if (response.status === 409) { swapRegions(await fetchPage(), true); banner(phase && phase.dataset.reset); if (doc.querySelector("[data-live]")) schedule(2000); return; }
    if (!response.ok) throw new Error("unavailable");
    const data = await response.json();
    if (offline) { offline = false; banner(phase && phase.dataset.reconnected); }
    const count = doc.querySelector("[data-needs-count]");
    if (count && typeof data.needs === "number") count.textContent = data.needs ? String(data.needs) : "";
    if (data.events && data.events.length) swapRegions(await fetchPage(), true);
    // Resume after what was just applied, so a long conversation is never re-read from its first page.
    if (app && typeof data.cursor === "number" && data.cursor > Number(app.dataset.cursor || 0)) app.dataset.cursor = String(data.cursor);
  } catch { offline = true; }
  // Polling stops once no row is live; an offline page keeps retrying until it reconnects.
  if (offline || doc.querySelector("[data-live]")) schedule(offline ? 5000 : 2000);
}

const initial = doc.getElementById("s15-composer");
if (initial) wireComposer(initial);
doc.addEventListener("click", onPrefill); wireCopy(doc);
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
