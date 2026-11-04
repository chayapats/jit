// Presentation only. State, work, approvals and effect settlement remain server-owned.
const s15Motion = (() => {
  const root = document.documentElement;
  const noop = { run: update => update(), enter() {}, close: (_element, done) => done(), layout() {} };
  if (!root || typeof globalThis.matchMedia !== "function") return noop;
  const preference = matchMedia("(prefers-reduced-motion: reduce)");
  const animations = new Set();
  let current = null, generation = 0;
  root.dataset.s15Enhanced = "true";
  const duration = name => Math.max(0, parseFloat(getComputedStyle(root).getPropertyValue(name)) || 0);
  const animate = (element, frames, token) => {
    if (!element || preference.matches || typeof element.animate !== "function") return null;
    const animation = element.animate(frames, { duration: duration(token), easing: "cubic-bezier(.22,1,.36,1)", fill: "none" });
    animations.add(animation); animation.finished.catch(() => {}).finally(() => animations.delete(animation));
    return animation;
  };
  preference.addEventListener("change", () => { if (preference.matches) { current?.skipTransition(); for (const animation of animations) animation.cancel(); } });
  return {
    run(update) {
      const ticket = ++generation; current?.skipTransition();
      // Never snapshot password/connection inputs or the protected owner-browser view.
      if (preference.matches || !document.startViewTransition || document.querySelector('input[type="password"], #s15-takeover-bar')) { update(); return; }
      const region = document.querySelector(".s15-app .s-scroll");
      if (!region) { update(); return; }
      region.style.viewTransitionName = "s15-reading";
      let applied = false;
      let nextRegion = null;
      const commit = () => { if (!applied && ticket === generation) { applied = true; update(); nextRegion = document.querySelector(".s15-app .s-scroll"); if (nextRegion) nextRegion.style.viewTransitionName = "s15-reading"; } };
      try {
        const transition = document.startViewTransition(commit); current = transition;
        transition.ready.catch(() => {}); transition.updateCallbackDone.catch(() => {});
        transition.finished.catch(() => {}).finally(() => {
          // An obsolete snapshot may own a disconnected node, but must not clear the next transition's name.
          if (current === transition) { region.style.removeProperty("view-transition-name"); nextRegion?.style.removeProperty("view-transition-name"); current = null; }
          else if (!region.isConnected) region.style.removeProperty("view-transition-name");
        });
      } catch { commit(); region.style.removeProperty("view-transition-name"); }
    },
    enter(element, back = false) {
      const centered = element?.closest?.('[data-s15-presentation="approval"]');
      animate(element, [{ opacity: 0, transform: centered ? "translateY(8px) scale(.985)" : `translateX(${back ? -12 : 18}px)` }, { opacity: 1, transform: "none" }], "--motion-panel");
    },
    close(element, done) {
      const centered = element?.dataset?.s15Presentation === "approval";
      const animation = animate(element, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: centered ? "translateY(6px) scale(.99)" : "translateX(12px)" }], "--motion-ui");
      if (animation) animation.finished.catch(() => {}).finally(done); else done();
    },
    layout(element, before) {
      if (!element || !before || typeof element.getBoundingClientRect !== "function") return;
      const after = element.getBoundingClientRect();
      if (Math.abs(after.height - before.height) > 2) animate(element, [{ height: `${before.height}px`, overflow: "clip" }, { height: `${after.height}px`, overflow: "clip" }], "--motion-panel");
    },
  };
})();
