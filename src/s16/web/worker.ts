import { readFileSync } from "node:fs";
import { en } from "../../i18n/en";
import { th } from "../../i18n/th";
import { assetUrl } from "../../web-assets";
import type { DesktopRelease } from "../desktop/release";

/** Fixed path of the S16 notification worker; its default scope is `/s16/`. */
export const s16WorkerPath = "/s16/sw.js";
/** Public no-store worker headers; network access is limited to its own origin's public client inventory/icon. */
export const s16WorkerHeaders = Object.freeze({ "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; connect-src 'self'; img-src 'self'" });

const placeholder = "const config = { copy: {}, icon: null };";
const kinds = ["needs_you", "result", "routine", "generic"] as const;

/**
 * The served worker: `sw.js` with its localized notice text (from `s16.notify.*` in both dictionaries) and the
 * hashed app icon filled in. An optional desktop inventory adds atomic public-asset installation. It holds no
 * installation, owner or conversation data, so it is served without a session.
 */
export function s16WorkerScript(desktop?: { release: DesktopRelease; csp: string }): string {
  const template = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  if (template.split(placeholder).length !== 2) throw new Error("sw.js must contain its config line exactly once");
  const copy = Object.fromEntries((["en", "th"] as const).map(locale => [locale, Object.fromEntries(kinds.flatMap(kind => (["title", "body"] as const).map(part => [`${kind}.${part}`, (locale === "en" ? en : th)[`s16.notify.${kind}.${part}`]])))]));
  const escape = (text: string) => text.replace(/[&<>"']/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[value]!);
  const recovery = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Jit</title><h1>Jit</h1><p>${escape(en["s16.desktop.unavailable"])}</p><p lang="th">${escape(th["s16.desktop.unavailable"])}</p><a href="/s16/">${escape(en["s16.desktop.reconnect"])} / ${escape(th["s16.desktop.reconnect"])}</a></html>`;
  const script = template.replace(placeholder, `const config = ${JSON.stringify({ copy, icon: assetUrl("icon-192.png"), ...(desktop ? { desktop: desktop.release, desktopCsp: desktop.csp, desktopRecovery: recovery } : {}) })};`);
  return desktop ? script + "\n" + readFileSync(new URL("./desktop-sw.js", import.meta.url), "utf8") : script;
}
