import { currentLocale, tr, withLocale, type Locale } from "./i18n";
import { assetUrl } from "./web-assets";
import { colorTokens } from "./web-design";

/** Escapes literal untrusted content before it enters HTML text or attributes. */
export const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
/** Owner appearance choice: `system` follows `prefers-color-scheme`. */
export type ThemePreference = "system" | "dark" | "light";
let activeTheme: ThemePreference = "system";
/**
 * Renders synchronously in the given language and theme. Page renderers read both from this scope,
 * so every page, including errors and sign-in, uses the same shell and dictionaries.
 */
export function renderWith<T>(ui: { locale: Locale; theme: ThemePreference }, render: () => T): T {
  const previous = activeTheme;
  activeTheme = ui.theme;
  try { return withLocale(ui.locale, render); } finally { activeTheme = previous; }
}

/** Browser chrome colour (web.pwa/v1): the page background of the theme in use, or of each system theme. */
function themeColor(): string {
  const meta = (theme: "dark" | "light", media = "") => `<meta name="theme-color" content="${colorTokens[theme].bg}"${media ? ` media="(prefers-color-scheme: ${media})"` : ""}>`;
  return activeTheme === "system" ? `${meta("dark", "dark")}${meta("light", "light")}` : meta(activeTheme);
}
/**
 * The full HTML document around a page body: theme, language, stylesheet, icons, web app manifest, fonts and the one
 * enhancement script. `viewport-fit=cover` lets the layout pad itself with the device safe areas; zoom stays allowed.
 */
export function documentPage(title: string, content: string): string {
  const theme = activeTheme === "system" ? "" : ` data-theme="${activeTheme}"`;
  return `<!doctype html><html lang="${currentLocale()}"${theme}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <meta name="color-scheme" content="${activeTheme === "system" ? "dark light" : activeTheme}">${themeColor()}<title>${escape(title)} · Jit</title>
    <link rel="stylesheet" href="${assetUrl("app.css")}"><link rel="icon" type="image/svg+xml" href="${assetUrl("favicon.svg")}">
    <link rel="manifest" href="${assetUrl("manifest.webmanifest")}"><link rel="apple-touch-icon" href="${assetUrl("apple-touch-icon.png")}">
    <link rel="preload" href="${assetUrl("inter.woff2")}" as="font" type="font/woff2" crossorigin><link rel="preload" href="${assetUrl("noto-sans-thai.woff2")}" as="font" type="font/woff2" crossorigin>
    <script type="module" src="${assetUrl("app.js")}"></script></head><body>
    <a class="skip" href="#main-content">${tr("common.skip_to_main_content")}</a>${content}</body></html>`;
}
