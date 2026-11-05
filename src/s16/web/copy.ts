import { en } from "../../i18n/en";
import { th } from "../../i18n/th";
import type { Locale, MessageKey } from "../../i18n";
export type Copy = (key: MessageKey, values?: Record<string, string | number>) => string;
/** Trusted plain-text dictionary lookup; React escapes values when inserting them into the DOM. */
export const copy = (locale: Locale): Copy => (key, values = {}) => (locale === "en" ? en : th)[key].replace(/\{([a-zA-Z]+)\}/g, (original, name: string) => String(values[name] ?? original));
