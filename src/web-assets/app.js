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

// Composer: ⌘/Ctrl+Enter submits through the form's own post; the textarea grows with its content.
for (const textarea of document.querySelectorAll(".composer textarea")) {
  const form = textarea.form;
  textarea.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && form?.reportValidity()) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  if (!CSS.supports("field-sizing", "content")) {
    const grow = () => { textarea.style.height = "auto"; textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`; };
    textarea.addEventListener("input", grow);
    grow();
  }
}
