---
status: proposed
scope: S14-D04/D08/D10/D11; refines ADRs 0010, 0012 and 0023 for S14
---

# Bounded concurrent work and replay-safe recovery

## Confirmed direction

Real multi-Bot concurrency is an MVP requirement. Owner commands and scoped routines grant internal work. Safe steps resume after interruption; unknown effects do not replay.

## Proposed choice

Represent one work item as a finite dependency graph of typed steps, not an agent-written executable workflow. Trusted handlers define input/output validation, allowed tools, resource leases and replay policy. A model can suggest decomposition; Jit validates it against the originating grant, Bot capabilities, dependency/step limits and current budget before admission.

Queue independent steps concurrently under global, route/credential, Bot and computer limits. Interactive queued work precedes background work. Dependent steps wait for committed evidence. Browser/desktop input and mutable workspace operations acquire their separate exclusive resources. A timeout retains capacity until the actual old operation settles or is proven stopped.

Keep Schway's native loop/turn retries and session management. Each admitted run has independent context and native ownership; a persistent Bot is not a shared mutable native session. A proposed process-stable opaque credential lifecycle must preserve renewal/logout fencing across different per-run hosts, exact routes and different tool/context policies. Jit must not create its own credential refresh client to remove the routeConcurrency=1 guard.

Checkpoint each step's immutable input/config/route, authority generation, native correlation, committed evidence and usage reservation. System-owned replay classes are replay_safe, reconcile_only and never_auto; unknown handlers default to reconcile_only. Pure reads can be replay_safe only within remaining reservations and live authority. Arbitrary shell, delivery and external effects are never automatically classified from model intent or readOnlyHint alone.

After restart, fence orphan attempts, discover correlated native sessions through a supported Schway API, settle/retire old work and revalidate source/config/authority. Only then may a replay_safe step resume. Expiry, revocation, changed input, unknown termination or exhausted budget waits with a concrete reason. Do not refund uncertain reservations or treat unknown token usage as zero.

Effects use a durable exact-action ledger and single-use approval. An executing effect that crashes becomes unknown/reconcile_only. Where a remote service offers a verified idempotency key or read-back, reconcile it through a trusted handler; otherwise require owner resolution. Never report exactly-once remote delivery from a local receipt alone.

Routines capture purpose/resources/tools/Bots, timezone/misfire and finite spend/time. Findings outside that captured mandate become proposals. Existing quiet/no_update and grouped notification semantics are retained.

## Contract prerequisites and consequences

[Schway #414](https://github.com/chayapats/schway/issues/414) covers native session correlation/enumeration. [SCH14-01](../proposals/schway/SCH14-01-shared-credential-lifecycle.md) proposes cross-host credential lifecycle ownership. Neither an open issue nor a passing single-host fixture proves supported concurrent dispatch. Pin the actual landed artifact/capability and packed-consumer conformance before enabling it.

Distinct same-provider accounts (#413) are separate from safe concurrency under one account and are not required by the accepted MVP.

## Evidence required

Barrier-driven concurrent Bots; route/credential ceilings; independent contexts; one refresh under overlap; logout/write-guard races; browser/workspace leases; dependency/partial sibling handling; crash windows before/after native creation and evidence commit; stale-authority resume denial; duplicate/unknown effect ledger; finite retry/budget accounting. Requirements: FR-02/06/12–FR-15/26/28/35/37; NFR-02/05/06/10.
