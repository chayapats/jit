---
status: accepted
scope: ROUT14-01 implementation choices within confirmed S14-AC10 and ADRs 0032/0048
---

# Captured routines and project-free in-app attention

Confirmed behavior remains owner-only captured standing authority, bounded normal work admission, quiet typed no_update, visible failures/decisions and proposal-only out-of-scope findings. This record selects implementation details, not new product authority or UI.

A routine is immutable configuration plus revisioned dispatch control. Editing scope is a new exact enable, while pause/resume preserves capture and remaining budget. At most 128 retained routines, 1000 occurrences per capture and a 366-day standing expiry bound this research slice. Work-bound shares cannot span independently created future work IDs. Every occurrence uses the ordinary work.start validator and graph at background priority; an exact capture equality check precedes commit. One occurrence per routine may be in flight. Default graphs validate finite per-run limits before enable.

Reuse the legacy pure schedule/quiet algorithms directly; they read no legacy store. Coalesce missed ticks into the latest due instant and retain missed count/DST resolution. Pause time is discarded on resume. The independent lifecycle ledger keeps consumed occurrence identities and monotonic total usage. If a restored image lacks consumed occurrence history, block rather than recreate lost work or refund budgets.

Project-free attention uses the existing dedupe/finite retry/unknown/resolution semantics with identities only. Production delivery in this phase is the persisted in-app surface. A trusted injected transport exists for deterministic conformance, with no real channel configured. One occurrence group spans immediate owner proposals and final outcome, avoiding intermediate sibling chatter. Local dedupe is never exactly-once remote delivery. Existing level changes affect only future informational intent creation.

The native routine path shares ordinary report publication/citation validation. A report candidate without an available committed report is a visible failure, never completion from model prose or an arbitrary JSON object. Home/Work select actual open proposal/waiting Work across all occurrences in SQL and return bounded per-routine aggregates (at most 128 captures), independently of the latest 100 notices. Failure escalation cannot hide an open decision, and finite-budget exhaustion does not dismiss a failure. The existing grouped presentation and owner pause/revoke history rule remain unchanged.

Contracts: app.routine-grants/v1 and app.attention-outbox/v1. Schema 11 is fresh-only; earlier unreleased versions refuse without changing their bytes. UI, managed backup/restore transport and real channel/device evidence remain separate work.

## UX14-02 review refinement (#279 / #280)

The 128-capacity ceiling applies to non-revoked captures. Recent revoked history is separately capped at 128; every live capture and every revoked capture with actual proposed/waiting work remains selected before history limits. Open proposal findings are queried directly from occurrence/work joins, independent of the 50-occurrence display history and the general work list. Resolution removes the decision from that selection; churn and acknowledgement cannot remove it. This refines the earlier retained-capture aggregate bound to preserve S14-AC10 / FR-12, FR-26, FR-28.
