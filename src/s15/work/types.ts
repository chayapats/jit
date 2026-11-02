import type { ConversationRequest } from '../conversation';
import type { Ref, S15PolicyService, OwnerActor, Usage } from '../policy';

/** Finite measured stall criteria supplied by protected configuration, never an invented owner budget.
 * A distinct approach without verified progress counts once. Reserve calls keep reporting headroom. */
export interface StallPolicy { noProgressApproaches: number; reserveCalls: number; maxAttempts: number }
/** Waits hold responsibility only. They never own a live VM/native session or an attempt permit. */
export interface ResponsibilityWait { kind: 'ci' | 'review' | 'owner' | 'schedule'; key: string; since: number; evidenceRefs: string[] }
/** Immutable protected-handler scope; an event cannot broaden the assigned purpose or selected subject. */
export interface ResponsibilityEvent { eventId: string; kind: 'ci' | 'review' | 'owner' | 'schedule' | 'assigned'; key: string; purposeId: string; resourceIds: string[]; subject: string | null; evidenceRefs: string[] }
/** Attempt facts retain independent transport settlement, progress evidence and unknown usage. */
export interface WorkAttempt { id: string; eventId: string; approach: string; startedAt: number; endedAt: number | null; state: 'active' | 'settled' | 'unknown'; capacityHeld: boolean; transportSettled: boolean; executionSettled: boolean; effects: 'known' | 'unknown'; publicationFenced: boolean; progress: 'unknown' | 'none' | 'made'; evidenceRefs: string[]; recommendation: string | null; usage: Usage; reconciliation: { basis: 'remote_verified' | 'owner_statement' | 'uncertain'; at: number; effects: 'known' | 'unknown'; complete: boolean; evidenceRefs: string[] } | null }
/** Read-only report. Recommendations are untrusted suggestions and cannot resume work by themselves. */
export interface StallReport { code: 'no_progress' | 'budget_headroom' | 'attempt_limit'; at: number; attempts: { id: string; approach: string; evidenceRefs: string[]; progress: WorkAttempt['progress'] }[]; recommendation: string; otherAuthorizedWorkContinues: true }
/** Durable responsibility projection, separate from any Schway loop or working VM allocation. */
export interface Responsibility {
  contract: 's15-responsibility/v1'; id: string; sourceRequestId: string; conversationId: string; originalText: string;
  ownerGeneration: number; workId: string | null; purpose: Ref | null; resources: Ref[]; subject: string | null; completion: string;
  triggers: ResponsibilityEvent['kind'][]; stallPolicy: StallPolicy;
  state: 'accepted' | 'ready' | 'working' | 'waiting' | 'paused' | 'reconcile_only' | 'completed' | 'stopping' | 'stopped';
  wait: ResponsibilityWait | null; attempts: WorkAttempt[]; report: StallReport | null;
  proposals: { eventId: string; code: 'outside_purpose'; evidenceRefs: string[] }[];
  readyEventId: string | null; stallCheckpoint: number; stopRequested: boolean; resumedAfterRestart: boolean; createdAt: number; updatedAt: number;
}
declare const attemptBrand: unique symbol;
/** Process-local original attempt identity; serializing/copying it never authorizes effects or publication. */
export interface AttemptHandle { readonly [attemptBrand]: true }
/** Assignment originates in authenticated CHAT data. Acceptance has no authority; execution uses the
 * exact admitted work ID. These options belong only to protected composition, never to model tools. */
export interface WorkOptions {
  runtime: 's15'; path: string; installationId: string; create: boolean; policy: S15PolicyService;
  conversation: { view(owner: OwnerActor, requestId: string): ConversationRequest };
  /** Protected remaining call headroom, including per-work subscription ceilings; null means unknown. */
  remainingCalls: (workId: string) => number | null;
  now?: () => number;
}
/** A trusted scoped settlement observation. Only owning transports/VM/effect services may attest settled;
 * a model result, timeout or guest exit is insufficient. Unknown effects always require reconciliation. */
export interface AttemptSettlement { transportSettled: boolean; executionSettled: boolean; effects: 'known' | 'unknown'; progress: 'none' | 'made'; evidenceRefs: string[]; recommendation: string; usage: Usage; complete?: boolean; /** Required to advance recovered facts or complete a responsibility through reconciliation. Missing basis is uncertain. Owner statements never attest remote outcome or settlement. */ basis?: 'remote_verified' | 'owner_statement' | 'uncertain' }
/** Stable host-only API consumed by GitHub babysitting. All event/settlement inputs are trusted service
 * observations, not model claims. Each new attempt still needs POLICY and owning-tool final I/O guards. */
export interface ResponsibilityPort {
  /** Capture the original authenticated conversation responsibility once; never turn acceptance into execution. */
  assign(owner: OwnerActor, input: { requestId: string; sourceRequestId: string; completion: string; triggers: ResponsibilityEvent['kind'][]; stallPolicy: StallPolicy }): Responsibility;
  /** Claim one ready event once under current authority. Lost handles cannot be recreated after restart. */
  beginAttempt(id: string, input: { eventId: string; approach: string }): AttemptHandle;
  /** Enter a durable wait only after actual attempt settlement; no VM/session is retained by this API. */
  wait(id: string, input: { requestId: string; kind: ResponsibilityWait['kind']; key: string; evidenceRefs: string[] }): Responsibility;
  /** Deduplicate a protected trigger; unrelated purpose/issue findings become proposals, never new work. */
  observeEvent(id: string, input: ResponsibilityEvent): Responsibility;
  /** Record original attempt observations even after stop; unknown capacity stays held and publication fenced. */
  settle(handle: AttemptHandle, observation: AttemptSettlement): Responsibility;
  /** Read-only owning-service reconciliation settles an exact old attempt; it never resends its effects.
   * Only basis:remote_verified may advance recovered facts. A complete, settled, known outcome can close
   * the responsibility while the old attempt's publication fence and lost/old handle stay unchanged. */
  reconcile(id: string, attemptId: string, observation: AttemptSettlement): Responsibility;
  /** Authenticated scoped stop fences this responsibility and its POLICY work; capacity remains until settlement. */
  stop(owner: OwnerActor, id: string, requestId: string): Responsibility;
  /** Resume only from a fresh authenticated CHAT execution message within this exact original scope.
   * The new message cannot install authority or revive stopped/revoked work. Historical reports remain. */
  resume(owner: OwnerActor, id: string, sourceRequestId: string): Responsibility;
  /** Rechecks the original live attempt and current POLICY authority before owning-service I/O. */
  guard(handle: AttemptHandle): void;
  /** Original-scope cooperative cancellation signal. Abort is not settlement or remote non-occurrence. */
  signal(handle: AttemptHandle): AbortSignal;
  /** Synchronous current publication of an eligible settled attempt; copied/recovered/stopped handles refuse. */
  publish(handle: AttemptHandle, consume: (attempt: WorkAttempt) => void): void;
  /** Authenticated read-only JSON projection; reads never start a model, VM, effect or replacement issue. */
  project(owner: OwnerActor, id: string): ResponsibilityProjection;
}
/** UI data for F9/12.3. Unknown components stay explicit, and scope lists only this responsibility. */
export interface ResponsibilityProjection extends Responsibility {
  budget: { charged: Usage; measured: Usage; unknown: (keyof Usage)[] };
  stopImpact: { responsibilityIds: string[]; heldAttempts: string[]; otherResponsibilities: number };
}
