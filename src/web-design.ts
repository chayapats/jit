/**
 * ui.design_tokens/v1 — the monochrome Jit visual system (S09-D06, docs/design/README.md).
 *
 * Dark is the default theme and light mirrors it token for token. There is no brand accent colour:
 * `--ok`, `--warn` and `--danger` are semantic text/icon colours only, and status always carries text.
 * The stylesheet is generated from these values, and tests/web-design.test.ts checks every pair in
 * {@link contrastPairs} against WCAG 2.2 AA in both themes.
 */
export type Theme = "dark" | "light";
export type ColorToken = "bg" | "surface-1" | "surface-2" | "surface-3" | "line" | "fg" | "fg-2" | "fg-3" | "on-fg" | "ok" | "warn" | "danger";

export const colorTokens: Readonly<Record<Theme, Readonly<Record<ColorToken, string>>>> = Object.freeze({
  dark: Object.freeze({
    "bg": "#0a0a0a", "surface-1": "#141414", "surface-2": "#1c1c1c", "surface-3": "#262626", "line": "#262626",
    "fg": "#ededed", "fg-2": "#a3a3a3", "fg-3": "#8a8a8a", "on-fg": "#0a0a0a",
    "ok": "#86efac", "warn": "#fde047", "danger": "#fca5a5",
  }),
  light: Object.freeze({
    "bg": "#fafaf9", "surface-1": "#ffffff", "surface-2": "#f4f4f3", "surface-3": "#ebebea", "line": "#e7e7e5",
    "fg": "#0a0a0a", "fg-2": "#525252", "fg-3": "#6b6b6b", "on-fg": "#fafaf9",
    "ok": "#15803d", "warn": "#8f5706", "danger": "#b91c1c",
  }),
});

/** Non-colour tokens shared by both themes (type scale in px, radii, motion). */
export const scaleTokens = Object.freeze({
  font: Object.freeze({
    sans: `"Inter", "Noto Sans Thai", system-ui, sans-serif`,
    mono: `"JetBrains Mono", ui-monospace, monospace`,
  }),
  size: Object.freeze({ xs: 12, sm: 13, ui: 14, chat: 15, lg: 18, xl: 24, xxl: 32 }),
  radius: Object.freeze({ control: 8, card: 14, composer: 24, pill: 999 }),
  motion: Object.freeze({ ui: 160, panel: 240, breath: 4800 }),
  chatWidth: 720,
});

/** Foreground/background pairs that carry text and must meet WCAG AA (4.5:1) in both themes. */
export const contrastPairs: readonly (readonly [ColorToken, ColorToken])[] = Object.freeze([
  ["fg", "bg"], ["fg", "surface-1"], ["fg", "surface-2"], ["fg", "surface-3"],
  ["fg-2", "bg"], ["fg-2", "surface-1"], ["fg-2", "surface-2"],
  ["fg-3", "bg"], ["fg-3", "surface-1"], ["fg-3", "surface-2"],
  ["on-fg", "fg"],
  ["ok", "bg"], ["ok", "surface-1"], ["ok", "surface-2"], ["warn", "bg"], ["warn", "surface-1"], ["warn", "surface-2"],
  ["danger", "bg"], ["danger", "surface-1"], ["danger", "surface-2"],
]);

const channel = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
export function luminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new TypeError(`not a #rrggbb colour: ${hex}`);
  const [r, g, b] = match.slice(1).map(part => channel(parseInt(part!, 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two `#rrggbb` colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CSS custom-property declarations for one theme. */
export const themeDeclarations = (theme: Theme) =>
  Object.entries(colorTokens[theme]).map(([name, value]) => `--${name}:${value};`).join("");
