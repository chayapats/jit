import { th } from "./th";
import { en } from "./en";

/**
 * ui.i18n_dictionary/v1 — the Web UI's message dictionaries (S09-D12, FR-25, NFR-11).
 *
 * Thai is the default language and defines the key set; English must define every key.
 * Values are trusted, plain-text constants without markup, so renderers insert them as-is.
 * Owner content never becomes a key or a value.
 */
export type Locale = "th" | "en";
export type MessageKey = keyof typeof th;
export const locales: readonly Locale[] = Object.freeze(["th", "en"]);
export const defaultLocale: Locale = "th";
export const dictionaries: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = Object.freeze({ th, en });

let active: Locale = defaultLocale;

/**
 * Renders synchronously with `locale` as the active language for {@link tr}.
 * Rendering is synchronous, so concurrent requests cannot observe each other's language; an async callback is rejected.
 */
export function withLocale<T>(locale: Locale, render: () => T): T {
  const previous = active;
  active = locale;
  try {
    const result = render();
    if (result instanceof Promise) throw new TypeError("withLocale requires a synchronous renderer");
    return result;
  } finally { active = previous; }
}

/** The language of the render in progress; Thai outside {@link withLocale}. */
export const currentLocale = (): Locale => active;

/** Looks up a UI label in the active language. A missing entry falls back to Thai, never to the raw key. */
export function tr(key: MessageKey): string {
  return dictionaries[active][key] ?? th[key];
}

/** Looks up a dynamic key (for example an error code); returns null when the dictionary has no such key. */
export function trMaybe(key: string): string | null {
  return Object.hasOwn(th, key) ? tr(key as MessageKey) : null;
}

/**
 * Chooses a supported language from an `Accept-Language` header (RFC 9110 weights).
 * Used only before an owner preference exists; unsupported or malformed input yields Thai.
 */
export function negotiateLocale(header: string | null): Locale {
  if (!header || header.length > 512) return defaultLocale;
  let best: Locale = defaultLocale, weight = 0;
  for (const part of header.split(",").slice(0, 16)) {
    const [range = "", ...params] = part.trim().toLowerCase().split(";");
    const q = params.map(p => /^\s*q=([01](?:\.\d{0,3})?)\s*$/.exec(p)?.[1]).find(Boolean);
    const value = q === undefined ? 1 : Number(q);
    const primary = range.trim().split("-")[0];
    const locale = locales.find(l => l === primary);
    if (locale && value > weight) { best = locale; weight = value; }
  }
  return best;
}
