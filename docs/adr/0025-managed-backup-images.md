---
status: accepted
scope: OPS01 engineering choices
---

# Staged managed backups with credential-free images

OPS01 (#18) implements FR-15, FR-16, FR-18 and NFR-05/08/09/10/12 as
`ops.backup_manifest/v1` (docs/contracts/ops-backup-manifest-v1.md). The
choices below are engineering decisions for this slice.

## Staged creation instead of one synchronous transaction

Native sessions can only be captured through Schway's asynchronous
`snapshotSessions`, which must not run inside a SQLite transaction. Backup
creation therefore captures the app image, inventory and exact native
reference plan in one immediate transaction, awaits the native capture, stages
files, and commits the manifest in a second transaction that re-checks the
native plan fingerprint. A manifest only names fully written files. Retention
rows are removed in the commit transaction, files only after commit; orphan
files (no committed manifest, outside the in-flight set and older than a grace
period) are reconciled on the next creation. `execute(backup.create)` returns a
Promise; other commands stay synchronous.

Finished native sessions are never reopened by Jit (one session per run), so
chunked `snapshotSessions` calls plus the fingerprint recheck yield a coherent
set without one lease spanning every session. Running sessions, unresolved
creation intents, missing/replaced sessions and incompatible snapshot
capabilities make the native part `incomplete`, never valid.

## Credentials never round-trip through images

Ordinary backup images are produced from an allowlisted table classification:
credential and live-authority tables are emptied, one-time secrets are
scrubbed, freed pages are zeroed and the image is vacuumed. Unclassified
tables fail creation closed, so new schema must be classified before it can
enter a backup. `TransactionStore.swapFrom` keeps the live installation's
credential rows on every activation (restore and upgrade rollback); restoring
into a fresh installation requires owner credential setup. An old backup can
therefore never resurrect a previous password verifier or browser session.

## Follow-ups

- Upgrade prepare (#32) runs inside one synchronous transaction and fails
  closed on staged engine ports; it should reuse staged backup creation.
- Inventory is bounded (1000 projects, 4000 sources) with explicit
  completeness. Larger installations need an out-of-row inventory; consumers
  (deletion preview, export) must treat `inventory.complete: false` as
  "may contain".
