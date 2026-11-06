/** Immutable text committed with a report or reminder. It is not a transport request. */
export interface DeliveryPayload {
  kind: "report" | "reminder";
  text: string;
  reference: {
    reportId: string;
    revision: number;
    generation: number;
    sourceId: string;
    sourceRevision: number;
    sourceGeneration: number;
  };
}

/** Where the committed payload came from. */
export interface DeliveryProvenance {
  reportId: string;
  reportRevision: number;
  reportGeneration: number;
  sourceId: string;
  sourceRevision: number;
  sourceGeneration: number;
  committedAt: number;
  authorityGeneration: number;
  inputGeneration: number;
}

/**
 * delivery.attention_levels/v1 classification. `needs_owner` is an item that waits on the owner (a question, a
 * proposal card, a decision awaiting acceptance, a failure or a blocked result), or an owner-configured schedule report or PR finding alert; everything else is `informational`.
 */
export type AttentionClass = "needs_owner" | "informational";

/** Classification and identities a producer stores on its intent; never text. */
export interface DeliveryAttention {
  class: AttentionClass;
  /** Owner-waiting item key inside its work group (for example `proposal:<id>`), or null for a one-off notice. */
  item: string | null;
  workGroupId: string | null;
}

/** Why a sent intent no longer stands for an open item. */
export interface DeliveryResolution { reason: "owner_answered" | "no_longer_waiting"; at: number }

/**
 * Local logical notification state. New intents stay `waiting` (in-app only) until cancelled; `claimed`, `sent`,
 * `failed` and `unknown` appear only on intents recorded by the push transport removed on 2026-11-06 (ADR 0085).
 * `sent` was a known remote response, never a claim that the report itself was delivered.
 */
export type DeliveryStatus = "waiting" | "queued" | "claimed" | "sent" | "failed" | "unknown" | "cancelled";

/** Remote acknowledgement recorded by the removed push transport; always `none` on new intents. */
export type DeliveryRemote = "none" | "accepted" | "rejected" | "uncertain";

/**
 * One logical private notification, shown in the app. There is no push transport in this runtime (ADR 0085): new
 * intents are never sent. Rows stored before the removal may carry extra legacy transport fields in their JSON
 * record; they are kept as-is and never read. `guarantee` is only local dedupe.
 */
export interface DeliveryIntent {
  id: string;
  dedupeKey: string;
  projectId: string;
  ownerId: "owner";
  authorityGeneration: number;
  inputGeneration: number;
  /** Domain guard name (for example `pr-alert`), or null/absent for unguarded intents. The owning domain retires stale intents. */
  guard?: string | null;
  /**
   * delivery.attention_levels/v1: how the producer classified this notice and the owner-waiting item it stands for.
   * Absent on intents committed before REL04.
   */
  attention?: DeliveryAttention | null;
  /**
   * delivery.attention_levels/v1: set when the item this intent stood for stopped waiting on the owner after the
   * intent had already been sent (or its send was in flight). It never claims the remote message was withdrawn.
   */
  resolution?: DeliveryResolution | null;
  payload: DeliveryPayload;
  provenance: DeliveryProvenance;
  status: DeliveryStatus;
  remote: DeliveryRemote;
  guarantee: "local_dedupe_only";
  failureReason: string | null;
  nextAction: string;
  /** Remote message reference recorded by the removed push transport; null on new intents. */
  messageRef: { chatId: number; messageId: number } | null;
  stale: boolean;
  staleReason: string | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Send attempt recorded by the push transport removed on 2026-11-06 (ADR 0085). Kept readable as history; no new
 * attempts are created.
 */
export interface DeliveryAttempt {
  id: string;
  intentId: string;
  generation: number;
  scheduler: string;
  leaseUntil: number;
  deadlineAt: number;
  ownerGeneration: number;
  bindingRevision: number | null;
  /** Chat captured when the sender is invoked. Later binding changes do not erase a known message reference. */
  chatId: number | null;
  state: "authorized" | "claimed" | "sending" | "settled" | "interrupted";
  senderInvoked: boolean;
  outcome: "none" | "sent" | "failed" | "unknown";
  reason: string | null;
  messageRef: { chatId: number; messageId: number } | null;
  stale: boolean;
  linkedFrom: string | null;
  createdAt: number;
}

/** Committed report or reminder. It has no delivered flag; delivery state lives on the intent. */
export interface DeliveryReport {
  id: string;
  projectId: string;
  kind: "report" | "reminder";
  revision: number;
  generation: number;
  availability: "available" | "superseded" | "deleted";
  text: string;
  sourceId: string;
  sourceRevision: number;
  sourceGeneration: number;
  committedAt: number;
}

/** Owner command that commits one report and at most one logical intent. */
export interface CommitDeliveryCommand {
  kind: "delivery.commit";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { kind: "report" | "reminder"; text: string; dedupeKey: string };
}

/** Owner command that supersedes or deletes a report and fences unsent intents. */
export interface RetireDeliveryCommand {
  kind: "delivery.retire";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { reportId: string; action: "supersede" | "delete" };
}

export type DeliveryCommand = CommitDeliveryCommand | RetireDeliveryCommand;

/** Receipt for a commit. `created` is false when the dedupe key already had an intent. */
export interface DeliveryReceipt {
  intent: DeliveryIntent;
  report: DeliveryReport;
  created: boolean;
}

/** Receipt for supersede or delete. Legacy already-accepted remote sends are not withdrawn. */
export interface DeliveryRetireReceipt {
  report: DeliveryReport;
  cancelledIntentIds: string[];
}

/** Bounded page of intents for owner inspection. */
export interface DeliveryPage {
  items: DeliveryIntent[];
  hasMore: boolean;
  nextAfter: number;
}
