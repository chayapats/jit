// Jit browser enhancements (ADR 0028). Hand-written ES module, no dependencies, no build step.
// Every page is complete without this file. It adds behaviour only: it never posts data itself and
// never reads or stores owner content. Forms still submit through the normal form post.

const root = document.documentElement;
root.dataset.enhanced = "true";

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
    if (event.key === "Escape" && app.dataset.drawer === "open") setOpen(false);
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

// Jit replies (app.jit_reply/v1): follow the topic's event stream and update each reply placeholder in place.
// Events carry persisted state and server-localised labels; text is set with textContent only, never as markup.
// The stream never starts work. Without this script the placeholder's refresh link shows the same state.
const chat = document.querySelector("[data-reply-stream]");
if (chat && typeof EventSource === "function") {
  const live = new Set(["thinking", "blocked"]);
  const stream = new EventSource(`${chat.dataset.replyStream}?cursor=${encodeURIComponent(chat.dataset.replyCursor ?? "0")}`);
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
    if (!live.has(data.state)) card.querySelector("[data-reply-stop]")?.remove();
    if (![...document.querySelectorAll("[data-reply-id]")].some(node => live.has(node.dataset.replyState))) stream.close();
  });
}
