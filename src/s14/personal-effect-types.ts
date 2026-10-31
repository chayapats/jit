import type { Effect } from "./authority-types";
import type { ScopeRef } from "./authority-types";
import type { Envelope } from "./types";
import type { MemoryRef } from "./memory-types";

/** Exact plain UTF-8 message; headers, recipients and text are never inferred from a summary. */
export interface PersonalMailDraft { kind: "mail"; to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }
/** Exact timed calendar fields sent as one reviewed change; recurrence and attendee notifications are explicit. */
export interface PersonalEventFields { summary: string; description: string; location: string; start: string; end: string; recurrence: string[]; attendees: string[] }
/** Exact event suggestion; null update/delete etags are bound by the broker to an actually-read source revision. */
export interface PersonalEventDraft { kind: "event"; operation: "create" | "update" | "delete"; eventId: string | null; etag: string | null; timezone: string; sendUpdates: "all" | "none"; event: PersonalEventFields | null }
/** Untrusted draft content can propose only one bounded mail or event action, never consent or approval. */
export type PersonalDraftContent = PersonalMailDraft | PersonalEventDraft;
/** Immutable draft revision bound to account, resource, work/attempt and its exact generic approval card. */
export interface PersonalDraft {
  id: string;
  revision: number;
  attemptId: string;
  workId: string;
  botId: string;
  scope: ScopeRef;
  connectionId: string;
  connectionRevision: number;
  account: string;
  calendarId: string | null;
  /** Exact actually-read event snapshot supplying the immutable update/delete etag; null for mail/create. */
  eventSource: MemoryRef | null;
  content: PersonalDraftContent | null;
  hash: string;
  expiresAt: number;
  effectId: string;
  payloadState: "present" | "deleted";
}
/** Exact authenticated owner revision of an existing held draft; any edit invalidates the old approval. */
export type PersonalEffectCommand = Envelope<"personal.draft.revise", { draftId: string; draftHash: string; content: PersonalDraftContent; expiresAt: number }>;
/** Draft revision receipt includes the new unapproved exact action, never credentials or write authority. */
export interface PersonalEffectReceipt { kind: "personal.draft.revise"; requestId: string; draft: PersonalDraft; effect: Effect }
/** Read-back evidence is separate from owner reconciliation and never authorizes another write. */
export interface PersonalEffectObservation {
  effectId: string;
  actionHash: string;
  state: "verified" | "accepted_unverified" | "unknown" | "not_applied";
  providerId: string | null;
  etag: string | null;
  checkedAt: number;
  meaning: "matching_sent_copy" | "matching_event" | "event_absent" | "provider_rejected" | "reconcile_only_no_retry";
}
/** Owner effect projection retains exact draft/card history and independently labelled provider observations. */
export interface PersonalEffectView { draft: PersonalDraft; history: PersonalDraft[]; effect: Effect; observation: PersonalEffectObservation | null }
