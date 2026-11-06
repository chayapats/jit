import type { ConversationOwnerRow, ConversationReceipt, ConversationRoutinePin } from "../../s15/conversation";
import type { FileArtifact, FileArtifactInputCommand, FileReference, FileUpload } from "../files/types";
import type { RoutineInstant, RoutineRecurrence, RoutineResolution } from "./schedule";

/** Owner-confirmed ceiling for every occurrence. It narrows CHAT interpretation; admission stays live POLICY. */
export interface RoutineScope { purposeId: string; resourceIds: string[]; access: "read" | "reversible_write" | "effect" }
/**
 * `s16-routine-draft/v1`: the exact configuration an owner reviews. `conversationId` is the conversation the
 * routine was set up from and where every occurrence posts. `misfire` decides what happens to instants that
 * fell due while the service was down: `coalesce` runs once for all of them, `skip` runs none of them.
 */
export interface RoutineDraft {
  contract: "s16-routine-draft/v1";
  conversationId: string; name: string; instruction: string;
  schedule: RoutineRecurrence | null; timezone: string;
  misfire: "coalesce" | "skip"; quiet: boolean;
  limits: { maxRuns: number; endsAt: number };
  scope: RoutineScope;
}
/** Server-computed review sheet. Saving requires this exact hash; it never stores or grants anything. */
export interface RoutineProposal {
  contract: "s16-routine-proposal/v1"; draft: RoutineDraft; ownerGeneration: number; policyRevision: number;
  next: RoutineInstant[]; effective: { purpose: RoutineCatalogEntry; resources: RoutineCatalogEntry[]; access: RoutineScope["access"]; reactions: { signed: boolean; github: boolean; artifacts: boolean } };
  proposalHash: string;
}
/** Owner-visible selectable purpose/resource from current standing policy and TEAM registration. */
export interface RoutineCatalogEntry { id: string; label: string; kind: string | null }
/** Current choices for the review sheet, recomputed on every read from live policy. */
export interface RoutineOptions {
  contract: "s16-routine-options/v1"; available: boolean; code: string | null;
  policyRevision: number | null; policyExpiresAt: number | null;
  purposes: RoutineCatalogEntry[]; resources: RoutineCatalogEntry[];
  defaults: RoutineScope | null;
  limits: { maxRuns: number; maxDays: number; intervalMinutes: { min: number; max: number }; nameBytes: number; instructionBytes: number };
}
/** Durable routine lifecycle. `ended` is terminal like `stopped`, and records why it ended. */
export interface Routine {
  contract: "s16-routine/v1"; id: string; revision: number; owner: { ownerId: string; generation: number };
  draft: RoutineDraft; proposalHash: string; policyRevision: number;
  state: "active" | "paused" | "stopped" | "ended"; endedReason: "exhausted" | "expired" | "completed" | null;
  anchor: number; cursor: number; runsUsed: number; skipped: number; attention: number;
  createdAt: number; updatedAt: number; pausedAt: number | null;
}
/** One trigger merged into an occurrence. Keys are derived identities, never payload text. */
export interface RoutineTrigger { kind: "schedule" | "run_now" | "event" | "file"; key: string; sourceId: string | null; at: number }
/**
 * One occurrence. `pending` is the single coalescing slot of a routine; `dispatching` is committed before the
 * CHAT submit, so restart resubmits the same request ID instead of creating a second responsibility.
 * `waiting_review` and an unacknowledged `unknown` hold the routine's next occurrence: one obligation at a time.
 */
export interface RoutineOccurrence {
  contract: "s16-routine-occurrence/v1"; id: string; routineId: string; seq: number;
  trigger: RoutineTrigger["kind"]; dueAt: number; local: string | null; resolution: RoutineResolution | null;
  coalesced: number; triggers: RoutineTrigger[]; input: FileReference | null;
  state: "pending" | "dispatching" | "submitted" | "running" | "waiting_review" | "unknown" | "needs_you" | "succeeded" | "quiet" | "failed" | "denied" | "stopped" | "refused" | "dropped";
  code: string | null; requestId: string | null; committedAt: number; dispatchedAt: number | null; settledAt: number | null;
  acknowledged: boolean; notified: boolean;
}
/** Diagnostic counters for one source. Refusals before a valid signature write nothing and are not counted. */
export interface RoutineSourceStats { accepted: number; coalesced: number; duplicates: number; ignored: number; refused: number; lastAt: number | null; lastOutcome: string | null }
/** A reaction source bound to exactly one routine. Its payload is a wake-up, never an instruction. */
export interface RoutineSource {
  contract: "s16-routine-source/v1"; id: string; routineId: string; kind: "github" | "signed" | "artifact"; revision: number;
  state: "active" | "revoked"; repository: string | null; events: string[]; artifact: { rootId: string; lastSeen: string | null } | null;
  createdAt: number; rotatedAt: number | null; revokedAt: number | null; stats: RoutineSourceStats;
}
/** Owner-facing source view: a path to configure, never the secret or its derivation key. */
export interface RoutineSourceView extends RoutineSource { path: string | null }
/** Installation feed state; only the SHA-256 of the token is kept. */
export interface RoutineFeedView { contract: "s16-routine-feed/v1"; enabled: boolean; names: boolean; revision: number; updatedAt: number | null }
/** List row with derived display state; reading it starts nothing. */
export interface RoutineSummary {
  routine: Routine; display: "active" | "running" | "waiting_for_you" | "blocked" | "paused" | "stopped" | "ended";
  next: RoutineInstant | null; remainingRuns: number; last: RoutineOccurrence | null; sources: number;
}
export interface RoutineList { contract: "s16-client-routines/v1"; routines: RoutineSummary[]; attention: number; feed: RoutineFeedView }
export interface RoutineDetail { contract: "s16-client-routine/v1"; summary: RoutineSummary; next: RoutineInstant[]; occurrences: RoutineOccurrence[]; sources: RoutineSourceView[] }
/** Command receipt. A minted secret or feed URL appears only in the response that created it, never in a replay. */
export interface RoutineReceipt { contract: "s16-routine-receipt/v1"; routine: Routine | null; source: RoutineSourceView | null; secret: string | null; feed: RoutineFeedView | null; url: string | null }

/** Protected composition ports. None of them is reachable by a model, tool, guest or channel message. */
export interface RoutineServiceOptions<Actor> {
  path: string; installationId: string; create: boolean;
  /** 0600 installation key file that derives per-source signing secrets; it never enters the journal. */
  keyPath: string; origin: string; now?: () => number;
  /** Authenticated owner identity of a live actor; throws when the session is not the current owner. */
  principal(actor: Actor): { ownerId: string; generation: number };
  /** Background owner authority for exactly this snapshot, or null when the owner generation changed. */
  owner(snapshot: { ownerId: string; generation: number }): Actor | null;
  /** Live standing policy choices; null when no usable policy is installed. */
  catalog(actor: Actor): { policyRevision: number; policyExpiresAt: number; purposes: RoutineCatalogEntry[]; resources: RoutineCatalogEntry[]; defaults: RoutineScope | null } | null;
  conversation: {
    submitRoutine(actor: Actor, command: unknown, pin: ConversationRoutinePin): ConversationReceipt;
    row(actor: Actor, requestId: string): ConversationOwnerRow;
    stop(actor: Actor, requestId: string): void;
  };
  /** Committed current artifacts and same-conversation adoption, when S16 files are composed. */
  files?: { committed(actor: Actor): { artifact: FileArtifact; parents: string[] }[]; adopt(actor: Actor, input: FileArtifactInputCommand): FileUpload };
  /** Calendar summary used when the owner has not chosen to publish routine names. */
  feedLabel?: string;
}
