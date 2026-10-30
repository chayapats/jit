import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");

test.each(["s14-work-status", "s14-pane-status"])("live refresh updates visible %s text and tone with the final result before polling stops", async badgeId => {
  let focused = false;
  const element = (innerHTML: string, className = "") => ({ innerHTML, className, dataset: {} as Record<string, string>, contains: () => focused, querySelector: () => null });
  const content = element("Running"), badge = element("Running", "s-pill strong");
  const nextContent = element("Evidence ready"), nextBadge = element("✓ Ready", "s-pill ok");
  const screen = element("original request ID"), nextScreen = element("fresh request ID");
  screen.dataset.sig = nextScreen.dataset.sig = "same-generation-and-lease";
  const controls = element("Agent control"), nextControls = element("Owner takeover");
  controls.dataset.sig = "lease-1"; nextControls.dataset.sig = "lease-2";
  const current = new Map([["s14-pane-live", content], [badgeId, badge], ["s14-computer-screen", screen], ["s14-computer-more", controls]]);
  const fresh = new Map([["s14-pane-live", nextContent], [badgeId, nextBadge], ["s14-computer-screen", nextScreen], ["s14-computer-more", nextControls]]);
  const page = (elements: typeof current, live: boolean) => ({
    documentElement: { dataset: {} }, body: {}, activeElement: {},
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    querySelector: (selector: string) => selector === "[data-live]" && live ? {} : null,
  });
  const ticks: Array<() => Promise<void>> = [];
  runInNewContext(source, {
    document: page(current, true), location: { href: "http://localhost:3001/work/fixture", hash: "" },
    DOMParser: class { parseFromString() { return page(fresh, false); } },
    fetch: async () => ({ ok: true, text: async () => "fresh page" }),
    setTimeout: (tick: () => Promise<void>) => ticks.push(tick),
  });
  // An active reader keeps content and badge together and defers the final poll.
  focused = true; await ticks.shift()!();
  expect(content.innerHTML).toBe("Running"); expect(badge.innerHTML).toBe("Running"); expect(ticks).toHaveLength(1);
  focused = false; await ticks.shift()!();
  expect(content.innerHTML).toBe("Evidence ready"); expect(badge.innerHTML).toBe("✓ Ready"); expect(badge.className).toBe("s-pill ok");
  expect(ticks).toHaveLength(0);
  expect(screen.innerHTML).toBe("original request ID");
  expect(controls.innerHTML).toBe("Owner takeover");
  expect(controls.dataset.sig).toBe("lease-2");
});
