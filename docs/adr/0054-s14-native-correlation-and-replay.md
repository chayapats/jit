---
status: accepted for opt-in implementation
scope: REC14-01; refines ADR 0048
---

# Correlation workspaces and conservative replay

The pinned public Schway artifact supports workspace-scoped session inventory but createSession does not accept a caller correlation identity. Persist an app intent and independent identity catalog before creation, then assign one service-owned workspace per intent in the shared managed session store. Inventory can find sessions created before the app saved their returned reference. Management uses inventory identities without opening native history, constructing a model or bypassing a live lease. Missing/corrupt/busy state remains unresolved. All hosts share the existing process credential lifecycle.

Boot holds the existing exclusive runtime lock, fences first, performs metadata cleanup, then evaluates the trusted research/synthesis replay registry. Fresh attempts require unchanged authority/config/route/source/graph and remaining finite reservations. Computer/core shell and external effects never gain replay safety from text. Stops and unknown effects never resume automatically. Local native retirement settles old transport only on a public acknowledgement; absence is conclusive only for the fenced pre-creation workspace, while a missing saved reference remains unresolved.

Keep charged reservation high-water marks and effect claims/outcome identities in the independent lifecycle store so a stale application image cannot refund uncertainty or reuse approval. Restore-discovered intents without app checkpoints block their original grant; unresolved orphans retain capacity. The owner may record an outcome on an exact unknown effect, with an explicitly labelled owner_statement and no retry or claim of verification. Native state remains unknown. Real remote read-back adapters and managed full-installation backup/restore remain separate slices.

The delivered app.work-checkpoints/v1 and app.replay-policy/v1 define the exact supported shapes, reasons, schema and deterministic evidence. These engineering choices implement the ticket's confirmed recovery boundary without claiming live reboot or exactly-once delivery.

## Reconciliation with main (#274)

Combined schema 14 retains every first-run, graph, report/review, sharing and recovery table; unreleased schemas 1–13 refuse with fresh-state. Keep main's drain ownership/wake-up protocol and orphan capacity accounting together, with the recovery barrier checked before drain entry. Native inventory and close finish before chat/work/computer workers start. Recovery keeps work queued while any graph lane is queued or waiting for evidence, including a synthesis whose producer committed immediately before the crash; committed producers are not repeated. Snapshot sources retain both producer-attempt and share pins, so uncited transitive producer withdrawal invalidates existing copies, descendants, report acceptance and artifact downloads, including stale-image restoration.

Deterministic integration evidence is in tests/s14-recovery.test.ts (queued siblings, committed dependency and wake-up ingress during native close) and tests/s14-reports.test.ts (shared report artifacts after upstream computer reset/delete). No live reboot or provider evidence is implied.
