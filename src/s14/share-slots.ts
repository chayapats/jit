import type { Policy } from "./types";
import type { AppTransaction } from "../store";

/** Finite built-in resource identities available for exact owner selection; availability grants no Bot or work access. */
export const managedShareSlots: readonly string[] = Object.freeze(Array.from({ length: 64 }, (_, i) => `share_slot_${String(i + 1).padStart(2, "0")}`));

/** Recognizes configured resources and built-in slots; accepted Bot ceilings and live resource/work policy still intersect. */
export function resourceConfigured(policy: Policy, id: string): boolean {
  return policy.resources.includes(id) || managedShareSlots.includes(id);
}

type SlotUse = "snapshot_share" | "share" | "personal_grant" | "coding_repository";
const reservations = `SELECT id,'snapshot_share' AS kind FROM snapshot_shares
  UNION SELECT id,'share' AS kind FROM memory_shares
  UNION SELECT id,'personal_grant' AS kind FROM personal_grants
  UNION SELECT id,'coding_repository' AS kind FROM coding_repositories
  UNION SELECT id,kind FROM lifecycle.withdrawals WHERE kind IN ('snapshot_share','share','personal_grant','coding_repository')`;

/** Returns occupied identities, including withdrawals, for the shared finite slot picker. A query never reserves a slot. */
export function reservedResourceSlots(tx: AppTransaction): Set<string> {
  return new Set(tx.all<{ id: string }>(reservations).map(row => row.id));
}

/** Refuses another resource user's identity even after revocation, deletion or stale-image restoration. */
export function resourceSlotConflict(tx: AppTransaction, id: string, claimant: SlotUse): boolean {
  return !!tx.get(`SELECT 1 FROM (${reservations}) WHERE id=? AND kind!=? LIMIT 1`, id, claimant);
}
