import type { Locale } from "../../i18n";
import { mobileOrigin, mobileServiceId } from "./transport";
/** Protected native configuration contains no credential or cached private thread. */
export interface MobileConfiguration { contract: "s16-mobile-configuration/v1"; locale: Locale; selected: string | null; services: readonly { readonly id: string; readonly origin: string }[] }
/** Empty first-install configuration; no endpoint, permission or enrollment is inferred. */
export const emptyMobileConfiguration: MobileConfiguration = Object.freeze({ contract: "s16-mobile-configuration/v1", locale: "th", selected: null, services: Object.freeze([]) });
const sha = (value: unknown): value is string => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === "string" && value.length >= 1 && value.length <= 128 && !/[^A-Za-z0-9_-]/.test(value);
/** Validate every restored service binding before any authenticated request; unknown keys are refused. */
export async function mobileConfiguration(raw: string | null): Promise<MobileConfiguration> {
  if (raw === null) return emptyMobileConfiguration;
  try {
    if (raw.length > 32768) throw Error(); const value = JSON.parse(raw);
    if (!value || Object.keys(value).sort().join() !== "contract,locale,selected,services" || value.contract !== "s16-mobile-configuration/v1" || !["en", "th"].includes(value.locale) || value.selected !== null && !sha(value.selected) || !Array.isArray(value.services) || value.services.length > 8) throw Error();
    const ids = new Set<string>();
    for (const entry of value.services) {
      if (!entry || Object.keys(entry).sort().join() !== "id,origin" || !sha(entry.id) || typeof entry.origin !== "string" || mobileOrigin(entry.origin) !== entry.origin || await mobileServiceId(entry.origin) !== entry.id || ids.has(entry.id)) throw Error();
      ids.add(entry.id);
    }
    if (value.selected !== null && !ids.has(value.selected)) throw Error();
    return Object.freeze({ ...value, services: Object.freeze(value.services.map((entry: { id: string; origin: string }) => Object.freeze({ ...entry }))) });
  } catch { throw Object.assign(new Error("mobile_configuration_invalid"), { code: "mobile_configuration_invalid" }); }
}
/** Pure native input parser. It can select a registered target only; it conveys no action or execution authority. */
export function mobileLink(value: unknown): { service: string; conversationId: string; requestId: string | null } | null {
  if (typeof value !== "string" || value.length > 512 || /[%?#]/.test(value)) return null;
  try {
    const url = new URL(value), parts = url.pathname.split("/");
    if (url.protocol !== "jit:" || url.hostname !== "open" || url.port || url.username || url.password || url.search || url.hash || ![3, 4].includes(parts.length) || parts[0] !== "" || !sha(parts[1]) || !id(parts[2]) || parts.length === 4 && !id(parts[3])) return null;
    if (value !== `jit://open/${parts[1]}/${parts[2]}${parts.length === 4 ? "/" + parts[3] : ""}`) return null;
    return Object.freeze({ service: parts[1]!, conversationId: parts[2]!, requestId: parts[3] ?? null });
  } catch { return null; }
}
