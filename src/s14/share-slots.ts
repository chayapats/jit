import type { Policy } from "./types";

/** Finite built-in resource identities available for exact owner selection; availability grants no Bot or work access. */
export const managedShareSlots: readonly string[] = Object.freeze(Array.from({ length: 64 }, (_, i) => `share_slot_${String(i + 1).padStart(2, "0")}`));

/** Recognizes configured resources and built-in share slots; the current Bot ceiling and live share/work policy still intersect. */
export function resourceConfigured(policy: Policy, id: string): boolean {
  return policy.resources.includes(id) || managedShareSlots.includes(id);
}
