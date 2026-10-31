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
  UNION SELECT json_extract(record_json,'$.repositoryId'),'git_connection' AS kind FROM git_connections WHERE json_extract(record_json,'$.removed')=0
  UNION SELECT id,kind FROM lifecycle.withdrawals WHERE kind IN ('snapshot_share','share','personal_grant','coding_repository')`;

// Only the explicitly selected live connection can release its own reservation for continuation.
const otherReservation = `NOT COALESCE((kind='git_connection' AND id=(
  SELECT json_extract(record_json,'$.repositoryId') FROM git_connections WHERE id=? AND json_extract(record_json,'$.removed')=0)
  AND NOT EXISTS (SELECT 1 FROM git_connections c WHERE json_extract(c.record_json,'$.repositoryId')=reservations.id
    AND json_extract(c.record_json,'$.removed')=0 AND c.id<>?)),0)`;

/** Returns occupied identities, including withdrawals. A selected connection can continue only its own reservation. */
export function reservedResourceSlots(tx: AppTransaction, connectionId?: string): Set<string> {
  return new Set(tx.all<{ id: string }>(`SELECT id FROM (${reservations}) reservations WHERE ${otherReservation}`,
    connectionId ?? null, connectionId ?? null).map(row => row.id));
}

/** Refuses another resource user's identity, allowing only the explicitly selected connection to continue. */
export function resourceSlotConflict(tx: AppTransaction, id: string, claimant: SlotUse, connectionId?: string): boolean {
  return !!tx.get(`SELECT 1 FROM (${reservations}) reservations WHERE id=? AND kind!=? AND ${otherReservation} LIMIT 1`,
    id, claimant, connectionId ?? null, connectionId ?? null);
}
