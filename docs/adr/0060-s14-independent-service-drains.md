---
status: accepted
scope: EVID14-01 service composition; preserves S14 FR/NFR authority and lifecycle contracts
---

# Independent service drains and joined shutdown

The service previously awaited chat and the entire authority graph drain before processing Git effects/read-back, attention, personal connection revocation, personal effects and Bot lifecycle cleanup. Authority retains its drain until admitted transports settle. Consequently a long model run delayed unrelated committed owner operations, including capability settlement for a Bot with no active transport.

Use an independent single-flight service lane for each of those consumers. Preserve chat-before-graph admission in the work lane and the authority scheduler's own queued-chat checks. Boot recovery, initial lifecycle cleanup and computer cleanup still finish before starting any service lane. Backup busy checks prevent new lane admission, and each domain's transactional authority, generation and transport guards remain authoritative. A lifecycle operation may inspect an unsettled transport and stay stopping; it never needs to wait for unrelated work to finish merely to perform that inspection. Git effects, attention, remote personal revocation and personal effects consume already committed state; none requires another consumer or all work to finish. Local personal revocation fences authority before its remote cleanup, so a concurrent effect still requires its original current authority.

Publish lane ownership before invoking ports, retain it until actual settlement, and isolate failures so one lane cannot prevent its peers from starting. A later maintenance tick can drain an idle lane while another remains active. This changes scheduling only, not approval, resource, generation, retry or publication semantics.

Shutdown seals lane admission before stopping ingress/timers. It retains backup settlement and authority shutdown, then joins every admitted service lane before computer recovery/cleanup, sign-in and shared credential lifecycle closure, store closure and runtime-lock release. Work waiting on chat cannot start a new graph drain after the seal. Shutdown does not treat cancellation as proof of transport settlement.

A barrier-driven regression uses the real application/authority scheduler and a held executor: the prior composition records no maintenance lane calls while the attempt is running. Additional checks cover lane single-flight, a slow/failing Git lane, independent peer progress, backup busy admission and shutdown waiting/fencing. These deterministic checks are not live host acceptance evidence.

Idle polling must not create durable work. On the x64 reference VM, an empty `BEGIN IMMEDIATE`/`COMMIT` with the attached lifecycle ledger repeatedly synced a super-journal; settled routine reconciliation also rewrote identical records and a settled review-waiting graph advanced its revision on every poll. Slow durable flushes then occupied the synchronous service thread and competed with Podman, even without a running Bot.

Keep `BEGIN IMMEDIATE` across every authority decision. When a transaction executes only plain `SELECT` through its projection methods and attempts no `run`, end it with rollback and return its result. Any attempted mutation, DDL, PRAGMA, non-SELECT statement or nested write keeps the existing durable commit path. Nested rollback remains conservative: an attempted child write can cause an unnecessary parent commit, never a missing commit. Do not change SQLite synchronous/journal settings, the attached-ledger atomicity, startup deadlines or isolation. Reconciliation preserves byte-identical routine records and settled graph revisions. Regression tests cover actual writer boundaries, later due dispatch, review-waiting graphs, nested writes, returning mutations, DDL and atomic failure across both databases. Host measurements and coding/registry evidence remain per-build private records.
