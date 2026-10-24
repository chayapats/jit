---
status: accepted
scope: OPS02 engineering choices
---

# Quarantined restore against an installation lifecycle ledger

OPS02 (#33) implements FR-15, FR-16, FR-18 and NFR-05/08/10/12 as
`ops.quarantined_restore/v1` (docs/contracts/ops-quarantined-restore-v1.md).
The choices below are engineering decisions for this slice.

## The latest ledger is installation state, not image state

A backup carries its own deletion ledger and suppressions, which can never
prove that nothing was deleted later. The latest trusted ledger therefore
lives outside every restore point: the append-only `lifecycle_ledger` table
(schema 23) is installation-scoped like credentials and the backup registry,
so backup images exclude it and every `swapFrom` keeps the live rows. SQLite
triggers on `deletion_ledger`, `memory_suppressions`,
`memory_suppressed_claims` and `memory_suppressed_sources` write identity-only
entries in the same transaction as every deletion and forget commit, so no
writer can forget to record one and no existing lifecycle code changed. The
deny lookups (`deletedSource`, `deletedClaim`, `suppressedSource`,
`suppressedClaim`) also consult it, which keeps a forget enforced even when
the restored image cannot represent it (the claim did not exist yet).

## An independent checkpoint detects a replaced database

The table shares a file with the swapped database. The checkpoint
(`jit.deletion.ledger/v1`, default `<db>.lifecycle-ledger.json`, service
`ledgerPath`) is a separately stored, atomically replaced, digest-protected
copy written after lifecycle commits, at boot and by restore. Trust requires
the checkpoint to be a verified prefix of the table; a lag is extended, while
a missing (after establishment at that location), unverifiable, incompatible
or diverged checkpoint fails closed. An in-database marker records the
location and position already checkpointed, distinguishing first
establishment (fresh install, first use after the upgrade, a seed placeholder
written by packaging) from loss. There is no acknowledgment override.

## One fence and one service lifecycle for restore and upgrade

Restore reuses the OPS06 fence file with `holder: "restore"`, so restore and
upgrade exclude each other and every managed writer that already honours the
upgrade fence stops during a restore. Control state (journal, receipts,
quarantine copy) is in files beside the database, as for upgrades, so
activation cannot erase its own evidence. The live installation is fenced and
quiesced from prepare to completion, which keeps its managed-state digest
stable; activation is bound to that digest and to the trusted ledger head.

## Reconcile before anything reads or works

Replay fences every restored attempt, holds every unsent notification as
unknown and parks every non-terminal job for an explicit owner resume:
anything in the image may already have happened after the backup. After the
swap, sessions are revoked (generation fence) and managed native deletion of
contexts citing deleted data runs through the team port while the fence still
holds (`ManagedService.fencedLifecycle`); only then is the fence released and
the service resumed with job/session/outbox reconciliation. A failed native
delete keeps the installation fenced and retryable rather than serving.

## Follow-ups

- Native session snapshots are not restored (`restoreSessionSnapshot`);
  native state is reconciled against the live engine instead.
- Restoring into another installation needs an import path and a human
  procedure for ledger authority; it is refused today (registry-bound).
- The service preflight gate still only checks the ledger file format before
  opening the store; `startFullApp` verifies the checkpoint after opening it.
  OPS07 should seed or create the checkpoint location and keep one location
  per installation.
