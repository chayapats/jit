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

test("declarations split across lines are reported at their start line", () => {
  const splitTransition = [".a {", " transition:", " opacity 200ms;", "}"].join("\n");
  expect(lintStyleSource(splitTransition, "split.css").map((v) => [v.line, v.rule])).toEqual([
    [2, "duration-literal"],
  ]);
  const splitRadius = [".a {", " border-radius:", " 10px;", "}"].join("\n");
  expect(lintStyleSource(splitRadius, "split.css").map((v) => [v.line, v.rule])).toEqual([
    [2, "radius-literal"],
  ]);
});

test("literals in later list items and font shorthands beside font-size are reported", () => {
  const laterItem = ".x { transition: color var(--motion-ui) ease-out, opacity 200ms ease-out; }";
  expect(lintStyleSource(laterItem, "list.css").map((v) => [v.line, v.rule])).toEqual([
    [1, "duration-literal"],
  ]);
  const bothFonts = ".x { font-size: var(--size-xs); font: 500 12px/1.6 sans; }";
  expect(lintStyleSource(bothFonts, "list.css").map((v) => [v.line, v.rule])).toEqual([
    [1, "font-size-literal"],
  ]);
});

test("transition-duration with a long-motion token fails", () => {
  expect(
    lintStyleSource(".a { transition-duration: var(--motion-breath); }", "duration.css").map((v) => v.rule),
  ).toEqual(["long-transition"]);
});

test("animation allowlist matches keyframe names exactly per list item", () => {
  const substring = ".a { animation: jit-breath-extra var(--motion-breath) ease-in-out infinite; }";
  expect(lintStyleSource(substring, "anim.css").map((v) => v.rule)).toEqual(["long-transition"]);
  const mixedList = ".a { animation: other var(--motion-breath), jit-breath var(--motion-ui); }";
  expect(lintStyleSource(mixedList, "anim.css").map((v) => v.rule)).toEqual(["long-transition"]);
  const exact = ".a { animation: jit-breath var(--motion-breath) ease-in-out infinite; }";
  expect(lintStyleSource(exact, "anim.css")).toEqual([]);
});

test("hover guards require hover and pointer-fine joined by and in one query", () => {
  const orList = "@media (hover: hover), (pointer: fine) { .g:hover { color: var(--fg); } }";
  expect(lintStyleSource(orList, "hover.css").map((v) => v.rule)).toEqual(["hover-outside-media"]);
  const joined = "@media screen and (hover: hover) and (pointer: fine) { .g:hover { color: var(--fg); } }";
  expect(lintStyleSource(joined, "hover.css")).toEqual([]);
});

test("mobile form inputs use a 16px token so iOS does not zoom", () => {
  expect(scaleTokens.size.input).toBe(16);
  const css = styleSheet({ inter: "/i", thai: "/t", mono: "/m" });
  expect(css).toContain("--size-input-mobile:16px");
  expect(css).toContain("font-size: var(--size-input-mobile)");
});
