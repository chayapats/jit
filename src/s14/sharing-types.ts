import type { Envelope } from "./types";
import type { MemoryRef } from "./memory-types";

/** Exact immutable source or delivered artifact identity; no path or profile is accepted. */
export interface SnapshotTarget { kind: "source" | "artifact"; id: string; revision: number; generation: number }
/** Owner-only nontransitive permission and bounded immutable copy for one receiver and optional work. */
export interface SnapshotShare {
  id: string; revision: number; target: SnapshotTarget; ownerBotId: string; receiverBotId: string;
  workId: string | null; expiresAt: number; active: boolean; source: MemoryRef;
  name: string; mediaType: "text/plain" | "text/markdown" | "application/json"; size: number; sha256: string;
}
/** Creates a share in an explicitly configured receiver resource slot without granting execution. */
export type CreateSnapshotShare = Envelope<"snapshot.share", { scopeId: string; target: SnapshotTarget; receiverBotId: string; workId: string | null; expiresAt: number }>;
/** Revokes future use at an exact share revision without claiming erasure of disclosed knowledge. */
export type RevokeSnapshotShare = Envelope<"snapshot.revoke", { shareId: string }>;
/** Authenticated snapshot-sharing command union. */
export type SharingCommand = CreateSnapshotShare | RevokeSnapshotShare;
/** Identity-only share receipt; copied content never enters command receipts. */
export interface SharingReceipt { kind: SharingCommand["kind"]; requestId: string; share: SnapshotShare }
/** Owner projection distinguishes unavailable copies from still-live permissions. */
export interface ShareView { share: SnapshotShare; state: "active" | "revoked" | "expired" | "unavailable"; disclosedKnowledge: "cannot_recall" }
