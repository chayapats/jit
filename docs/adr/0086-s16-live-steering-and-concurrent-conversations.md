---
status: implemented for CHAT16-02 (#406); deterministic and real-bundle browser evidence; live evidence separate
date: 2026-11-06
scope: CHAT16-02 (#406); S16-AC02; FR-06/14/15/19/24/29; NFR-05/06/11
---

# Live steering through a Schway contract, and concurrent conversations

## Context

S16-AC02 needs the owner to keep talking while work runs: adjust the running work, start an unrelated conversation, and stop one task without losing others. CHAT ran one request at a time across the whole installation, and Schway offered only submit and cancel for an admitted run. A Jit-only design (cancel and resubmit, or wait for the run to finish) would either discard progress or delay the steer until the work was already done.

## Decision

1. Schway gains a public `schway.host.steering/v1` contract ([schway#460](https://github.com/chayapats/schway/issues/460)): `session.steer({ id, text })` on an admitted run, applied at the next safe boundary in acceptance order, with an exact applied/unapplied/uncertain report on every terminal outcome. Schway owns in-run application only; Jit owns durability.
2. CHAT adds `s16-conversation-steer/v1` with a durable `steers` table and six dispositions ([contract](../contracts/s16-steering-v1.md)). Unapplied steers become exactly one ordinary follow-up; uncertain ones are never resent; stopped targets only record them.
3. Steering text is owner input inside the target's frozen scope. It never widens tools, resources, access or budgets, and never decides a held action (S16-D08 keeps approval on the in-chat card).
4. The CHAT drain runs up to two requests at once (configurable to eight), one per conversation, so an independent conversation proceeds while another works or waits for approval.
5. The S16 client composer steers the newest running request of the open conversation and offers "start a separate conversation" instead; each owner message shows its steers with their disposition.

## Consequences

- MODEL15 `runStep` and the direct CHAT runner both open steering at the first authorized send and settle it from the run's report.
- Concurrency increases peak working-computer and model usage; existing per-request budgets, VM leases and policy reservations still bound each request.
- A process loss leaves handed steers `uncertain`, visible to the owner, rather than guessing.

## Alternatives considered

- *Cancel and resubmit with the steer*: loses in-flight progress and risks repeating effects.
- *Queue the steer as the next message*: simple, but the work finishes before the adjustment lands.
- *Unbounded concurrency*: risks exhausting the working computer; a small fixed bound is predictable.
