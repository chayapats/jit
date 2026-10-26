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

const systemKeys = new Map((Object.keys(th) as MessageKey[]).filter(key => key.startsWith("system.")).map(key => [th[key] as string, key]));

/**
 * Localizes a fixed explanatory note that a domain read model returns in Thai (for example a schedule's
 * next-run note or a task's pending reason). Only exact matches of a `system.*` entry are translated;
 * anything else, including owner and model text, is returned unchanged. Callers still escape the result.
 */
export function systemText(value: string): string {
  const key = systemKeys.get(value);
  return key ? tr(key) : value;
}

/**
 * Chooses a supported language from an `Accept-Language` header (RFC 9110 weights).
 * Used only before an owner preference exists; unsupported or malformed input yields Thai.
 */
export function negotiateLocale(header: string | null): Locale {
  if (!header || header.length > 512) return defaultLocale;
  const explicit = new Map<Locale, number>();
  let wildcard: number | null = null;
  for (const part of header.split(",").slice(0, 16)) {
    const [range = "", ...params] = part.trim().toLowerCase().split(";");
    // RFC 9110: the only parameter is one weight, a qvalue from 0 to 1 with at most three decimals.
    // Any other or malformed parameter disqualifies the range.
    const qualifiers = params.map(p => p.trim());
    if (qualifiers.length > 1 || (qualifiers.length === 1 && !/^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(qualifiers[0]!))) continue;
    const value = qualifiers.length ? Number(qualifiers[0]!.slice(2)) : 1;
    // RFC 4647 basic language range; a malformed range never matches a supported language.
    const tag = range.trim();
    if (!/^(?:\*|[a-z]{1,8}(?:-[a-z0-9]{1,8})*)$/.test(tag)) continue;
    if (tag === "*") { wildcard = Math.max(wildcard ?? 0, value); continue; }
    const locale = locales.find(l => l === tag.split("-")[0]);
    if (locale) explicit.set(locale, Math.max(explicit.get(locale) ?? 0, value));
  }
  // A supported language takes its own range's quality, otherwise the wildcard's; q=0 means unacceptable.
  // The highest quality wins, Thai on ties and when nothing acceptable remains.
  let best: Locale = defaultLocale, quality = 0;
  for (const locale of locales) {
    const q = explicit.get(locale) ?? wildcard ?? 0;
    if (q > quality) { best = locale; quality = q; }
  }
  return best;
}
