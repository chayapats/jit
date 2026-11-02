import type { ColorToken, Theme } from "../web-design";

/** S14 Plain palette. State words and exact action details remain independent of colour. */
export const s14Colors: Readonly<Record<Theme, Readonly<Record<ColorToken, string>>>> = {
  light: { bg: "#ffffff", "surface-1": "#f8f8f6", "surface-2": "#f2f2ef", "surface-3": "#eaeae6", line: "#e5e5df", fg: "#282825", "fg-2": "#60605b", "fg-3": "#6b6b65", "on-fg": "#ffffff", ok: "#40403b", warn: "#57574f", danger: "#373732" },
  dark: { bg: "#171716", "surface-1": "#1d1d1b", "surface-2": "#252523", "surface-3": "#333330", line: "#353531", fg: "#efefea", "fg-2": "#c2c1ba", "fg-3": "#aaa9a1", "on-fg": "#171716", ok: "#deded6", warn: "#d0cfc5", danger: "#efefea" },
};

/** Same-origin S14 theme declarations; shared legacy tokens are unchanged. */
export const s14Theme = (theme: Theme): string => Object.entries(s14Colors[theme]).map(([key, value]) => `--${key}:${value};`).join("");

/** Dimensions specific to the Plain shell; legacy layout tokens retain their original values. */
export const s14Scale = { nav: 244, pane: 500, chat: 760, cardRadius: 8, composerRadius: 16, tileRadius: "26%" } as const;
