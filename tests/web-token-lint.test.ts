import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { effectTokens, scaleTokens } from "../src/web-design";
import { styleSheet } from "../src/web-style";
import { lintStyleSource, longMotionAllowlist, tokenLintTargets } from "../src/web-token-lint";

test("planted violations are reported with file, line and rule", () => {
  const fixture = [
    ".a { color: #fff; }",
    ".b { background: rgba(0, 0, 0, .5); }",
    ".c { font-size: 13px; }",
    ".d { font: 500 11px/1.6 var(--font-sans); }",
    ".e { border-radius: 10px; }",
    ".f { transition: color 200ms ease-out; }",
    ".g:hover { color: var(--fg); }",
    ".h:active { transform: scale(.97); }",
    ".i { transition: opacity var(--motion-breath); }",
  ].join("\n");
  const violations = lintStyleSource(fixture, "test.css");
  expect(violations.map((v) => [v.line, v.rule])).toEqual([
    [1, "color-literal"],
    [2, "color-literal"],
    [3, "font-size-literal"],
    [4, "font-size-literal"],
    [5, "radius-literal"],
    [6, "duration-literal"],
    [7, "hover-outside-media"],
    [8, "press-scale-literal"],
    [9, "long-transition"],
  ]);
  for (const violation of violations) {
    expect(violation.file).toBe("test.css");
    expect(violation.text.length).toBeGreaterThan(0);
  }
});

test("allowed forms pass", () => {
  const allowed = [
    ".a { font-size: 0; }",
    ".b { font: inherit; }",
    ".c { border-radius: 0; }",
    ".d { border-radius: 50%; }",
    ".e { border-radius: var(--radius-card) var(--radius-card) var(--radius-tail) var(--radius-card); }",
    ".f { transition: visibility 0s linear var(--motion-panel); }",
    "@media (hover: hover) and (pointer: fine) { .g:hover { color: var(--fg); } }",
    "@media (max-width: 680px) { @media (hover: hover) and (pointer: fine) { .g:hover { color: var(--fg); } } }",
    ".h { animation: jit-breath var(--motion-breath) ease-in-out infinite; }",
  ].join("\n");
  expect(lintStyleSource(allowed, "allowed.css")).toEqual([]);
});

test("the real stylesheet has zero violations", () => {
  for (const target of tokenLintTargets) {
    const source = readFileSync(join(import.meta.dir, "..", target), "utf8");
    expect(lintStyleSource(source, target)).toEqual([]);
  }
});

test("transition tokens stay under 300 ms", () => {
  expect(scaleTokens.motion.ui).toBeLessThan(300);
  expect(scaleTokens.motion.panel).toBeLessThan(300);
  const style = readFileSync(join(import.meta.dir, "../src/web-style.ts"), "utf8");
  for (const [name, reason] of Object.entries(longMotionAllowlist)) {
    expect(style).toContain(`@keyframes ${name}`);
    expect(reason.trim().length).toBeGreaterThan(0);
  }
});

test("rendered stylesheet still themes", () => {
  const css = styleSheet({ inter: "/i", thai: "/t", mono: "/m" });
  expect(css).toContain("--size-chat:15px");
  expect(css).toContain("--radius-pill:999px");
  expect(css).toContain("--press-scale:0.97");
  expect(css).toContain(effectTokens.shadow.dark);
  expect(css).toContain(effectTokens.shadow.light);
});
