import { dictionaries, type Locale, type MessageKey } from "../../i18n";
/** Locale-bound plain-text lookup; each renderer escapes substituted values. */
export type Copy = (key: MessageKey, values?: Record<string, string | number>) => string;
/** Shared browser/native copy. Dictionary text and owner substitutions never become markup or authority. */
export const copy = (locale: Locale): Copy => (key, values = {}) => dictionaries[locale][key].replace(/\{([a-zA-Z]+)\}/g, (original, name: string) => String(values[name] ?? original));
