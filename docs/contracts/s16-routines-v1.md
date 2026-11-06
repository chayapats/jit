# S16 routines and reactions v1

ROUT16-01 [#414](https://github.com/chayapats/jit/issues/414) and ROUT16-02 [#415](https://github.com/chayapats/jit/issues/415) deliver `s16-routines/v1`: owner-confirmed scheduled responsibilities and signed event/file reactions on opt-in S15 + the S16 client. Decision record: [ADR 0083](../adr/0083-s16-routines-and-reactions.md). Requirements: S16-AC09; FR-04, FR-08, FR-09, FR-11, FR-12, FR-15, FR-26, FR-28, FR-33, FR-34; NFR-05, NFR-06, NFR-10. Exported TSDoc in `src/s16/routines/` is the actual API.

A routine is configuration, not authority. Every occurrence enters CHAT through a protected ingress and is admitted under the **current** standing policy, with the owner-confirmed purpose, resources and access as a ceiling. Saving a routine starts nothing; Run now is an explicit execution command. Payloads, model output and channel text cannot create, change or widen a routine.

## Selection and storage

Routines exist only when the composition receives `routines: {}` (`routines: true` in `s15-runtime/v1`). Omission keeps the installation unchanged: no store, routes or capability. Enabling it on an existing installation adds `routines.sqlite` through the composition manifest's additive-store rule. A later boot without the option refuses instead of silently dropping a listed store. S14 defaults, installed standing policy, private scopes and owner-host configuration are not changed.

`routines.sqlite` is a protected `DurableJournal` (application ID `0x52543136`, exclusive process lease, FULL synchronous transactions). Tables: `routines_v1`, `occurrences_v1`, `sources_v1`, `deliveries_v1`, `event_keys_v1` and `feed_v1`. `routine-hooks.key` (32 random bytes, `0600`, `O_EXCL|O_NOFOLLOW` create, `fstat`-checked read) derives per-source signing secrets. No secret, sealed secret, token or payload is stored in the journal.

## Draft, review and save

```ts
type RoutineRecurrence = { kind: "once"; date: "YYYY-MM-DD"; time: "HH:MM" } | { kind: "daily"; time } | { kind: "weekly"; days: number[] /* 0=Sun, sorted, unique */; time } | { kind: "interval"; minutes: 15..10080 };
interface RoutineDraft { contract: "s16-routine-draft/v1"; conversationId; name /* ≤240 bytes, one line */; instruction /* ≤4000 bytes */;
  schedule: RoutineRecurrence | null /* null: reactions only */; timezone /* IANA */; misfire: "coalesce" | "skip"; quiet: boolean;
  limits: { maxRuns: 1..366; endsAt /* > now, ≤ now+366 days, ≤ standing policy/budget expiry */ };
  scope: { purposeId; resourceIds: string[] /* 1..16 */; access: "read" | "reversible_write" | "effect" } }
```

- `POST /api/s16/client/routines/proposals` (body: draft) validates against the live standing policy and TEAM registrations. It returns `s16-routine-proposal/v1`: the canonical draft, the next three instants with their local reading and DST resolution, the effective purpose/resources/access and which reaction kinds the scope allows, plus `proposalHash = sha256("s16.routine.proposal.v1", { draft, ownerGeneration, policyRevision })`. Nothing is stored.
- `GET /api/s16/client/routines/options` lists the selectable purposes (standing purposes except the interpretation purpose), registered active resources with their TEAM labels, the policy expiry, defaults and fixed limits.
- `routine.confirm { requestId, draft, proposalHash }` recomputes the proposal and saves only an identical hash (`stale_proposal` otherwise). A routine records the owner snapshot `{ ownerId, generation }`, the conversation it was set up from, the policy revision it was reviewed under, `anchor = cursor = now`, `runsUsed = 0`. At most 32 active or paused routines per owner (`routine_capacity`).

The client opens the review sheet from the conversation composer (Schedule). A conservative en/th prefill (`suggestSchedule`) reads only the owner's own unquoted composer text. It is a suggestion; the server never parses message text into a routine.

## Schedule semantics

All wall-clock kinds evaluate in the routine's own timezone, never the host zone, using the existing `wallToUtc` helper:

| Case | Behavior | Documented count |
| --- | --- | --- |
| DST gap (written time does not exist) | Runs once at the first valid local minute after it (`gap_shifted`). `America/New_York` daily 02:30 runs at 03:00 EDT (07:00Z) on 2026-03-08. | 7 local days → 7 runs |
| DST fold (written time occurs twice) | Runs once, at the first occurrence (`overlap_first`). Daily 01:30 runs at 05:30Z on 2026-11-01, never again at 06:30Z. | 7 local days → 7 runs |
| `interval` | Absolute minutes from the save anchor; local readings shift across DST. | 24 h → 24 runs |
| Downtime, `misfire: "coalesce"` | All instants in `(cursor, now]` become **one** occurrence at the latest instant, with `coalesced = count − 1`. Friday-noon → Tuesday-noon around the 2026-03-08 gap: 4 due → 1 run, `coalesced: 3`. | n due → 1 run |
| Downtime, `misfire: "skip"` | If the latest due instant is more than 10 minutes old, none runs; `skipped += count`. Otherwise only the latest runs. Same window: 4 due → 0 runs, `skipped: 4`. | n due → 0 runs |
| Pause → resume | Instants while paused are counted in `skipped`, never replayed. Resume does not renew scope, budget or end date. | — |

A scan of due instants evaluates at most 10,000 instants and still coalesces.

## Occurrences

```ts
interface RoutineOccurrence { id /* oc_… */; routineId; seq; trigger: "schedule" | "run_now" | "event" | "file"; dueAt; local; resolution; coalesced; triggers /* ≤16 merged identities */; input: { id; sha256 } | null;
  state: "pending" | "dispatching" | "submitted" | "running" | "waiting_review" | "unknown" | "needs_you" | "succeeded" | "quiet" | "failed" | "denied" | "stopped" | "refused" | "dropped"; code; requestId; … acknowledged; notified }
```

- **One coalescing slot.** A routine has at most one `pending` occurrence. Later due instants, Run now and reaction triggers while it exists merge into it (`coalesced++`, trigger list).
- **One obligation at a time.** The next occurrence dispatches only when nothing of the routine is `dispatching`, `submitted`, `running`, `waiting_review` or an unacknowledged `unknown`. A review wait therefore holds the routine while scheduled instants coalesce into the single pending slot.
- **Dispatch.** In one journal transaction the occurrence becomes `dispatching`, receives the deterministic CHAT request ID `ro_<occurrence>` and consumes one run. The service then calls `ConversationApplication.submitRoutine`. A process loss in between resubmits the same request ID on restart; CHAT's dedupe returns the original receipt, so exactly one responsibility exists. If CHAT refused before committing, the run is returned to the budget. Transient refusals (`conversation_unavailable`, `continuity_capacity`, `service_closed`) retry up to five times. CHAT keeps a queued request's runnable registration in process memory only, so a restarted service resubmits every `submitted`/`running` occurrence once with its original request ID, pin and the file receipts from CHAT's own saved command (never a fresh adoption); CHAT returns the original receipt and re-registers it if still queued. A `dispatching` claim that CHAT already saved is recovered the same way; if CHAT refuses to re-register it, the saved request is stopped so it settles instead of waiting forever.
- **Owner authority.** Background dispatch and observation re-establish only the recorded owner snapshot through the protected composition seam. A changed owner generation makes the occurrence `refused` with `owner_changed` (no budget, display `blocked`); it never runs as the new owner.
- **Budget and end.** `maxRuns` counts dispatched occurrences. No occurrence is admitted once the budget is spent or the end date passed (the pending slot is dropped). After the end date a claimed `dispatching` run is recovered only if CHAT already saved its request; otherwise it is refused with `expired` and its run returned. The routine becomes `ended` only after its outstanding run settles, so a final run can still be retried and stopped: budget spent, end date passed, or one-time schedule run with no active reaction source. Ended and stopped routines revoke their sources.
- **History bound.** Admission is never limited by history. The journal keeps the newest 400 rows of a routine and discards older `refused`/`dropped` rows, which consumed no run; dispatched rows are bounded by `maxRuns`.

### CHAT routine ingress (`s16-routine-run/v1`)

`ConversationApplication.submitRoutine(actor, command, pin)` is reachable only from protected composition. The pin `{ routineId, occurrenceId, purposeId, resourceIds, access, quiet }` is stored on the request and is part of the command identity; reusing the request ID as an ordinary message is `request_id_conflict`. For a pinned request:

- the interpretation catalog is intersected with the pin; a purpose or resource outside it, or an access level above it, holds the request with `outside_scope`;
- exact owner decisions in the text (`approve …`) are not parsed; only a live owner message can decide;
- continuations are refused;
- admission, tools, file guards, memory, publication and effect gates are the ordinary CHAT/POLICY path under the current standing policy.

`ConversationOwnerRow.routine` (additive) labels the row so clients show a routine run, not a live owner message.

### Outcome mapping and attention

Occurrence states come only from CHAT's committed owner row:

| CHAT row | Occurrence |
| --- | --- |
| pending exact slip | `waiting_review` (holds the routine) |
| reconcile-only / unknown slip | `unknown` (holds until the owner acknowledges; never retried) |
| held without a slip (question, policy, budget, unsupported, partial) | `needs_you` (visible in Needs you; does not hold) |
| completed result | `quiet` if the owner chose a quiet routine and the result is exactly a typed `{"outcome":"no_update"}` (`normalizeSummaryOutcome`), else `succeeded`; a failed/expired/denied slip makes it `failed` |
| blocked / stopped / denied | `failed` / `stopped` / `denied` |

A quiet run is retained in history and the conversation but increments no attention. Every other settled outcome, including `refused`, increments the routine's attention once (`notified`). `routine.seen` clears it. When the owner chose a quiet routine, the composition adds one host-authored owner decision (`routineQuietDecision`) telling the model it may reply with exact `no_update` only when nothing is new. A run without a successful observation is never quiet: CHAT holds it with `result_unavailable`.

## Owner commands

`POST /api/s16/client/routines/commands`, Web session + exact Origin + CSRF, body `{ kind, requestId, … }`, idempotent by request ID (`request_id_conflict` on a changed body). Routine commands carry `routineId` and `expectedRevision` (`stale_revision`). The revision counts owner-visible configuration and lifecycle changes only; background scheduling does not bump it.

| Kind | Effect |
| --- | --- |
| `routine.confirm` | Save an exactly reviewed draft. |
| `routine.run_now` | Open or join the pending slot (`routine_budget_exhausted` when none remains). |
| `routine.pause` / `routine.resume` | Stop opening occurrences (pending slot dropped) / continue from now. |
| `routine.stop` | Terminal. Drops the pending slot, stops the routine's submitted/running/waiting CHAT request and fences a claimed `dispatching` submit so it is never resubmitted; revokes sources. |
| `routine.acknowledge { occurrenceId }` | Owner statement that an `unknown`/`needs_you` run was handled; certifies no outcome. |
| `routine.seen` | Clear attention. |
| `routine.source.create { source }` / `.rotate { sourceId }` / `.revoke { sourceId }` | See Reactions. |
| `feed.enable` / `feed.rotate` / `feed.disable` / `feed.names { names }` | See Calendar feed. |

Reads: `GET /api/s16/client/routines` (`s16-client-routines/v1`, ≤64 newest, display state, next instant, remaining runs, attention total, feed state), `GET /api/s16/client/routines/:id` (`s16-client-routine/v1`, next three instants, ≤400 occurrences newest first, sources with diagnostics). Reads never tick, dispatch or notify. The capability projection adds `routines: { available, contract: "s16-client-routines/v1", reactions: { signed, github, artifacts }, feed }`; bootstrap adds `routines.attention`.

## Reactions (ROUT16-02)

A reaction source belongs to exactly one routine (≤8 active). Its delivery is a wake-up: the payload is never stored, never shown to a model and never used as instruction, purpose, resource or recipient. Only validated identity fields are extracted for coalescing and diagnostics.

**Signed and GitHub sources require a read-only routine** (`reaction_requires_read_scope`). A monitor, CI or review event therefore never selects or starts implementation (FR-08); a mutating run needs an owner start. File reactions allow up to `reversible_write` (not `effect`).

### Ingress

`POST /hooks/s16/routines/<sourceId>` on the service origin, no session. Each step refuses before the next and every refusal before a valid signature writes nothing:

1. foreign `Host` → 403; not `POST` → 405; any `Origin`, `Sec-Fetch-Site` or `Cookie` → 403;
2. unknown, revoked or artifact source → 404;
3. body over 256 KiB → 413;
4. more than 30 requests per source per 60 s → 429 with `Retry-After` (counted before the signature, in memory);
5. signature:
   - `github`: `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256(secret, body). GitHub does not sign its delivery ID, so replay safety comes from payload identities (below);
   - `signed`: `X-Jit-Signature: t=<unix s>,v1=<hex>` = HMAC-SHA256(secret, `"s16-routine-event/v1\n" + t + "\n" + X-Jit-Delivery + "\n" + X-Jit-Event + "\n" + (X-Jit-Key ?? "") + "\n"` + body). `|now − t| > 300 s` → 401 `event_expired`;
   constant-time comparison, 401 `signature_invalid` otherwise;
6. delivery ID (`X-GitHub-Delivery` / `X-Jit-Delivery`, `[A-Za-z0-9._:-]{1,128}`) → 400 when missing.

The secret is `jitrt_` + base64url(HMAC-SHA256(key, `s16.routine.source.v1\n<sourceId>\n<revision>`)). It is shown once in the create/rotate response; replayed receipts carry `secret: null`. Rotation increments the revision, so the old secret stops verifying in the same transaction.

### Admission, dedupe and coalescing

In one transaction, before the 202 acknowledgement:

- deliveries older than 7 days are pruned; a repeated delivery ID → 202 `duplicate`;
- GitHub `ping` → `pong`; unselected event, action or repository → `ignored`; a payload timestamp (`check_suite.updated_at`, `workflow_run.updated_at`, `review.submitted_at`) older than 24 h or more than 5 min in the future → 409 `event_expired`;
- a paused/stopped routine → 409 with zero work;
- **identity keys** (retained 30 days per routine): CI = `ci:<repository>:<head_sha>` (check suite and workflow run of one commit are one identity), review = `review:<repository>:<pr>:<review id>`, signed = `event:<name>:<X-Jit-Key or delivery ID>`, file = `file:<lineage root>:<artifact id>`. A seen key → `coalesced`, no new work. Reordered or late deliveries of an older commit are seen keys;
- a new key opens the pending slot (`scheduled`) or joins it (`coalesced`); a spent budget → 409 `routine_budget_exhausted`.

The admission identity is committed before acknowledgement, and the occurrence dispatches through the same `dispatching` record, so a restart between commit and dispatch creates exactly one responsibility.

### File reactions

`{ kind: "artifact", artifactId }` names one committed artifact in the routine's own conversation; the source watches that exact lineage (root = first-parent chain), never a path or file name. Each scheduler wake compares the newest committed, current descendant (deepest first, then newest) with the last one seen. A revision produced by the routine itself never wakes it. On dispatch the exact revision `{ id, sha256 }` is adopted into the routine conversation through the existing same-conversation adoption path and submitted as an `s16-conversation/v2` file command. A withdrawn source, a changed hash or a substituted blob (symlink, size or hash mismatch, `O_NOFOLLOW`) refuses the occurrence (`lineage_withdrawn`/`file_integrity_failed`) with no CHAT request and no budget.

## Calendar feed (FR-34)

One installation feed for the owner. `feed.enable`/`feed.rotate` mint a 32-byte base64url token; only its SHA-256 is stored; the absolute URL `<origin>/feeds/s16/routines/<token>.ics` appears once in that response (`url: null` in replays). `feed.disable` deletes the hash. `GET /feeds/s16/routines/<token>.ics` compares digests in constant time; malformed, wrong, rotated or disabled tokens are the same bodiless 404. It writes nothing and starts nothing.

Contents: active scheduled routines, upcoming instants in `(max(cursor, now), min(now + 30 days, endsAt))`, at most the routine's remaining runs, at most 5000 events. `VEVENT`: `UID <routineId>-<revision>-<instant>@jit`, `DTSTAMP`, UTC `DTSTART`, `SUMMARY`, `TRANSP:TRANSPARENT`. `SUMMARY` is the generic label unless the owner turned on `feed.names`; instructions, scopes and conversation content never appear. Paused, stopped and ended routines contribute nothing. RFC 5545 escaping and 75-octet folding reuse `app.schedule_feed/v1` helpers.

## Evidence

Deterministic, scripted models and protocol fixtures with a fake clock; no live account:

- `tests/s16-routine-schedule.test.ts`: DST gap/fold counts, weekday/weekly zones, interval across DST, downtime coalescing, one-time schedules, validation refusals.
- `tests/s16-routines.test.ts`: review hash and replay, real CHAT run with pin and evidence; DST + downtime `coalesce`/`skip` counts; quiet vs needs-you (Needs you, attention, acknowledge); restart while an exact approval waits (one obligation, no model call, no live VM, one dispatch after approval); quoted, model and chat text cannot create/broaden/decide; pause/resume/run now/budget/stop; owner generation change; calendar feed contents, redaction, rotation, revocation and no writes; additive store on an existing installation.
- `tests/s16-routine-events.test.ts`: one-time secrets and every refusal with a whole-journal no-change check; header tampering; GitHub duplicate/reordered/expired/ignored and busy-time coalescing with documented identities; payload never reaching model or journal; restart between commit and dispatch and between CHAT commit and record; personal GitHub policy unreachable from a CI reaction; file lineage reaction with same-name, self-output, substitution and withdrawal cases; stop fencing a claimed submit.
- `tests/s16-routines.browser.test.ts` (opt-in `JIT_S16_BROWSER_TESTS=1`): actual bundle in English 1440 px and Thai 390 px, composer Schedule → prefilled sheet → review → save → Run now → history, signed source secret shown once, labelled routine run in the conversation, no overflow, no external requests.

## Limits and pending

- Editing a saved routine is not offered; stop and create a new one. Routines run as the conversation's configured Bot (TEAM/BOT16 own per-Bot choice).
- Notifications are in-app attention and Needs you only; channel delivery of routine outcomes belongs to CHANNEL16-01 [#424](https://github.com/chayapats/jit/issues/424).
- File reactions watch committed artifact lineages; host folder watching is not offered. Working-computer file output collection remains #433.
- CI/review reactions wake a routine; they do not settle S15 WORK `ci`/`review` waits, which have no production driver yet.
- Live GitHub webhook delivery, Linux x64/arm64 runs and owner-host activation are pending (#431/#432).
