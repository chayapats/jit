# app.personal-effects/v1

LIFE14-02 logic, S14 Phase C; FR-06/07/15/17/37/38; NFR-05/07/10/11. Consumes `app.personal-read-connectors/v1`, `app.effect-approval/v2`, `app.work-grants/v1`, `app.routine-grants/v1`, memory/source/lifecycle and `app.work-checkpoints/v1`. `S14Application.personal.effects:PersonalEffects`, `personal-effect-types.ts`, `personal-effect-validation.ts`. Combined schema **14**, unreleased 1–13 refuse; read connector was introduced in schema 13. No private Schway integration or credential enters a model/execution box.

`propose(attemptId,requestId,scope,content,expiresAt):PersonalEffectView` is a trusted worker/draft tool, **never approval**. Requires an enabled exact Bot/resource/work grant and explicitly consented `gmail.send` plus `effect_send`, or `calendar.events` plus `effect_calendar`. A readonly connection with a captured effect tool still cannot write. Repeated proposal keys return the same draft only under live authority and identical input hash. Scope/account/connection revision cannot change through a draft edit.

Exact `PersonalDraftContent` shapes:

```ts
type PersonalMailDraft = {
  kind: 'mail', to: string[], cc: string[], bcc: string[], subject: string, body: string
};
type PersonalEventDraft = {
  kind: 'event', operation: 'create'|'update'|'delete',
  eventId: string|null, etag: string|null, timezone: string,
  sendUpdates: 'all'|'none',
  event: null | {
    summary: string, description: string, location: string,
    start: string, end: string, recurrence: string[], attendees: string[]
  }
};
```

Mail: exact plain UTF-8 subject/body with explicit To/CC/BCC, at most 20 unique plain ASCII mailbox addresses total, no header injection, attachments, HTML or alias discovery. The connection's immutable account label is the reviewed From; its verification label must be visible. Body whitespace is preserved. The broker builds fixed MIME, UTF-8 encoded subject, folded recipients, base64 body, deterministic Message-ID per draft revision and base64url raw. It never accepts arbitrary MIME, provider endpoints or headers from a model. `gmail.send` alone does not verify an account email; no identity/read scope is silently added.

Calendar: exact configured calendar ID plus event identity, IANA timezone, RFC3339 start/end with matching actual timezone offsets (including DST), complete selected recurrence and attendee arrays and explicit notification mode. Create input has null eventId/etag; broker generates one random base32hex-compatible ID, displayed **before** approval, reused only for that logical unexecuted draft. Update/delete require exact event ID and etag; update uses PATCH with precisely the reviewed fields and `If-Match`; unspecified provider fields remain unchanged, while reviewed arrays replace existing arrays. A preflight GET verifies current ID/etag; delete also verifies the reviewed event timezone. Whole-series versus occurrence targeting follows the exact provider event ID. Unsupported all-day/attachments/conference/organizer operations are refused, rather than disguised as broader edits. `calendar.events` permits event read-back; calendar name metadata/evidence checks additionally need explicit readonly consent.

The broker canonicalizes the complete draft, account, calendar, resource ref, connection revision, attempt, revision and expiry into `EffectAction{kind:'send'|'calendar',destination:'google-personal/<connection>/<slot>',content:canonicalEnvelope}`. `PersonalDraft.hash` equals the generic card's SHA-256 actionHash. Generic `approval.decide` remains the sole exact owner approval boundary: `{effectId,actionHash,decision}` at the current effect revision, under session/Origin/CSRF. Source/model/email/event text can only propose pending content. There is no standing write rule. Current scope, owner/Bot/attempt, payload hash, expiry and connection consent recheck at claim and immediately before each broker request.

`personal.draft.revise{draftId,draftHash,content,expiresAt}` at current draft revision replaces the held generic card with a new unapproved revision and retains changed history. Editing any recipient/subject/body/event ID/etag/timezone/recurrence/attendee/time/description/notification invalidates old approval. Executing, terminal and unknown actions cannot be revised. A changed connection requires fresh work/resource capture and a new draft, not rebinding the card.

`runEffect` durably consumes the generic approval and independent claim tombstone before calling the broker. `effects.drain()` processes only approved personal cards; duplicate calls/drains/crash restore never reissue an unknown or terminal write. Per-request budgets remain finite. Timeouts request abort and retain the original performer/attempt capacity until actual transport settlement. No exception text/remote error body enters logs, prompts or receipts. Known provider rejection/precondition failure is failed; uncertain exceptions/timeout/late authority changes are unknown. A local receipt never promises exactly-once remote delivery.

Gmail has **no documented idempotency key**. The broker sends once. With explicitly granted Gmail readonly it verifies the returned sent-copy ID and exact selected MIME headers/body; after an ambiguous response it may search SENT by the deterministic Message-ID, require one result and verify it. Message-ID is correlation, **not provider deduplication**. Missing/duplicate/mismatching copies remain unknown. Send-only scope cannot read back: a returned message ID records `accepted_unverified` while the effect remains unknown for owner reconciliation. Matching sent copy means that copy exists, not that a recipient received/read it. Gmail may normalize headers, so strict verification can honestly remain unknown.

Calendar create uses one client-supplied event ID and GET read-back; Google documents that globally distributed collisions are not guaranteed to be detected, so no exactly-once claim follows. Update/delete use conditional etags; a changed etag or 412 refuses without reapplying. Create/update verify exact desired ID/fields/timezone/recurrence/attendees, and update requires a changed etag. Delete verifies absent/cancelled state after its conditional request. After ambiguous results only GET occurs; no second mutation is sent.

Provider observations are `{effectId,actionHash,state:'verified'|'accepted_unverified'|'unknown'|'not_applied',providerId,etag,checkedAt,meaning}`. `reconcile(actor,draftId,expectedRevision,actionHash)` is an owner-requested bounded read-back under current connection/Bot resource consent, even after execution grant expiry; it cannot POST/PATCH/DELETE or approve. It updates separate provider evidence and leaves the original unknown dispatch ledger intact. Existing `effect.reconcile` records an explicit **owner_statement**, distinct from provider verification; neither outcome can retry the action. Revocation blocks new read-back; unresolved history stays inspectable.

Opt-in evidence guard: trusted option `personal.evidenceGuard:true`, production environment `JIT_S14_PERSONAL_EVIDENCE_GUARD=1`. It requires actual same-token Gmail readonly profile, exact From/self-only recipients, or actual same-token Calendar readonly metadata whose summary is exactly `Jit test`, immediately before the write. Missing permission/metadata/name mismatch refuses before mutation. This is only a live-evidence safeguard; normal product recipients/calendars remain owner-approved choices. No live OAuth/provider call or live-evidence env file was used here.

New schema 14 tables: `personal_drafts` (attempt/request uniqueness, input digest and credential-free record), `personal_draft_versions` and `personal_effect_observations`. Generic effects/versions and independent claim/outcome ledger remain the authority source. Bot lifecycle previews enumerate personal read/draft identity/hash metadata; deletion scrubs current/history/receipt payload caches for owned and forward-derived attempts, retaining action hashes/outcomes and independent originals. Unknown effects never become replayable after deletion/restore. Connection installation metadata and sealed credentials are separate owner resources, not Bot payloads.

Deterministic evidence: `tests/s14-personal-effects.test.ts`, `tests/fixtures/s14-personal-crash.ts`, pinned protocol sources/date **2026-10-31** in `src/s14/protocol/google-personal.json`. Includes exact edits, stale/denied/expired/revoked/forged decisions, source injection, separate write consent, DST/recurrence, duplicate/crash/timeout, conditional conflict, idempotent identity/read-back and self/test-calendar guard. Product Web UI, accessibility/device and real self-send/Jit-test-calendar evidence remain unticked for the orchestrator/Opus.
