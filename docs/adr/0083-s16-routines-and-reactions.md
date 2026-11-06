---
status: selected for ROUT16-01/ROUT16-02 implementation; deterministic composition and browser evidence; live acceptance separate
date: 2026-11-06
scope: ROUT16-01 (#414), ROUT16-02 (#415); S16-AC09; FR-04/08/09/11/12/15/26/28/33/34; NFR-05/06/10
---

# Routines and signed reactions run through CHAT's protected ingress

## Context

S16-AC09 needs conversational schedules and signed event/file reactions that survive restart, coalesce missed or duplicate triggers, respect finite budgets and review waits, stay quiet only on real "nothing new" results, and can never be created or widened by quoted text or payloads.

The baseline offered three partial pieces:

- **S14 `app.routine-grants/v1`** has captured grants, recurrence, coalesced misfire and quiet `no_update`, but it lives in the S14 store, runs on the S14 work graph and grants authority at enable time. S15/S16 work runs on CHAT + POLICY with live admission.
- **S15 `s15-responsibility/v1` (WORK)** has durable waits that hold no session and reconcile-only unknowns, but a responsibility binds one admitted POLICY work ID with an attempt cap of 64 and expiring authority. A routine needs a fresh admission per run under the then-current policy, for up to a year. WORK has no production scheduler.
- **Legacy `app.webhook_triggers/v1` and `app.schedule_feed/v1`** show the right webhook pipeline (refuse-before-write, constant-time HMAC, delivery dedupe, payload never parsed into work) and feed rules (hashed token, shown once), but belong to the project-centric store.

Rakazo at `abf3c08145a05cba92a912d6c24fdfb5f569d0e0` (Apache-2.0) was inspected as the product reference. Its `Routine` stores cron strings evaluated with `croner` per IANA zone and runs on Graphile Worker over PostgreSQL. No misfire/catch-up policy or per-routine run cap was found. Its GitHub webhook verifies `X-Hub-Signature-256` with `timingSafeEqual`, dedupes by a body hash, and passes only allowlisted metadata (never event-authored text) to the model.

## Decision

**A dedicated S16 routine journal over CHAT, not a new scheduler or authority.** `RoutineService` keeps routines, occurrences, sources, deliveries, identity keys and the feed in its own protected `DurableJournal` (`routines.sqlite`, opt-in additive store). It owns only *when* to wake and *what coalesces*. Each occurrence is submitted to CHAT as an ordinary request through `submitRoutine`, so interpretation, POLICY admission, TEAM resources, VM/browser/file tools, memory, publication guards, held effects and reconciliation are exactly the conversational path. Saving a routine grants nothing; standing policy decides every run.

**Pin, don't grant.** The owner-confirmed purpose, resources and access ceiling become an immutable `s16-routine-run/v1` pin on the CHAT request. CHAT intersects its interpretation catalog with the pin and holds anything outside it (`outside_scope`). Pinned text never parses as an exact owner decision. The pin is part of the request identity, so the deterministic request ID `ro_<occurrence>` makes resubmission after any process loss return the original receipt.

**Reuse WORK's semantics, not its ledger.** Like WORK, waits hold no VM or native session, unknown outcomes are reconcile-only and never retried, and settlement facts come from the owning service (CHAT's committed owner row). The routine holds its next run while an exact approval or an unknown outcome is outstanding ("one obligation at a time"), with later triggers merged into a single pending slot. A separate per-routine WORK responsibility was rejected: it would bind one expiring work authority and cap a year of runs at 64 attempts.

**Structured recurrence on the existing DST helper, not cron.** `once`/`daily`/`weekly days`/`interval` cover the authored presets and keep DST interpretation explainable in the review sheet. They reuse `wallToUtc` (gap → first valid minute, fold → first occurrence) instead of adding `croner`. Explicit `coalesce`/`skip` misfire policies and a finite `maxRuns`/`endsAt` (bounded by policy expiry) fill the gaps found in the reference. The review sheet shows the next three instants with their resolution before save; save requires the exact server-computed proposal hash.

**Quiet is typed and earned.** An occurrence is quiet only when CHAT completed with a result that is exactly `{"outcome":"no_update"}` (the existing `jobs.quiet_outcomes/v1` normalizer). CHAT already refuses a result without a successful observation, and holds, failures, unknowns and refusals always raise attention. The owner's quiet choice reaches the model only as one host-authored owner decision.

**Reactions are wake-ups.** Signed (`X-Jit-Signature` over timestamp, delivery, event, key and body; 5-minute window) and GitHub (`X-Hub-Signature-256`) sources adopt the legacy refuse-before-write pipeline. GitHub CI/review payloads contribute only validated identity fields (`ci:<repo>:<sha>`, `review:<repo>:<pr>:<id>`). Like Rakazo's body-hash nonce, these keys make GitHub redeliveries with fresh delivery IDs coalesce. Unlike Rakazo, no payload metadata reaches the model at all: the routine reads current state with its own tools (as `app.webhook_triggers/v1` does). Signed and GitHub sources require a read-only routine (FR-08), so an event never starts implementation or reaches a personal publish/merge exception. Per-source secrets are derived from a `0600` installation key and the source revision, so nothing secret is stored and rotation is a revision bump.

**File reactions follow a lineage, not a path.** A source names one committed artifact in the routine's conversation. New committed descendants (not produced by the routine) wake it, and the exact revision is adopted through ART16's same-conversation copy path. Withdrawal, hash change and blob substitution refuse through existing FileStore guards. Host-folder watching was rejected: it would need a configured host path (terminal setup) and a new protected filesystem boundary.

**Calendar feed reuses REL08 rules.** Hashed token shown once, constant-time 404s, no writes, generic summaries unless the owner opts into names, never instructions.

## Consequences

- No S14/S15 default, installed rule, policy or private scope changes. `routines: true` adds one store and the session-free routes `/hooks/s16/routines/<source>` and `/feeds/s16/routines/<token>.ics`; disabling it again refuses to boot rather than silently drop the store.
- CHAT gains one protected method and one optional request field. Older releases never resubmit pinned requests (process-local registration), so a rollback cannot run a pinned occurrence without its pin.
- Each scheduler wake is a few indexed queries per active routine. Artifact watching recomputes the committed library per active file source.
- No Rakazo source or dependency is imported; the comparison informed misfire, dedupe and payload-isolation choices only.
- Pending: editing a saved routine, channel notifications (#424), WORK CI/review wait settlement from events, host-folder reactions, live GitHub delivery and Linux/owner-host evidence (#431/#432).
