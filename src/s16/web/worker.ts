import { readFileSync } from "node:fs";
import { en } from "../../i18n/en";
import { th } from "../../i18n/th";
import { assetUrl } from "../../web-assets";

/** Fixed path of the S16 notification worker; its default scope is `/s16/`. */
export const s16WorkerPath = "/s16/sw.js";
/** Public, no-store, script-only response headers. The worker loads nothing except its notification icon. */
export const s16WorkerHeaders = Object.freeze({ "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; img-src 'self'" });

const placeholder = "const config = { copy: {}, icon: null };";
const kinds = ["needs_you", "result", "routine", "generic"] as const;

/**
 * The served worker: `sw.js` with its localized notice text (from `s16.notify.*` in both dictionaries) and the
 * hashed app icon filled in. It holds no installation, owner or conversation data, so it is served without a session.
 */
export function s16WorkerScript(): string {
  const template = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
  if (template.split(placeholder).length !== 2) throw new Error("sw.js must contain its config line exactly once");
  const copy = Object.fromEntries((["en", "th"] as const).map(locale => [locale, Object.fromEntries(kinds.flatMap(kind => (["title", "body"] as const).map(part => [`${kind}.${part}`, (locale === "en" ? en : th)[`s16.notify.${kind}.${part}`]])))]));
  return template.replace(placeholder, `const config = ${JSON.stringify({ copy, icon: assetUrl("icon-192.png") })};`);
}
