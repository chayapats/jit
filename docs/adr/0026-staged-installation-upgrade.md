---
status: accepted
scope: OPS06 engineering choices
---

# Staged installation upgrade with control state outside the swapped database

OPS06 (#32) implements FR-04, FR-15, FR-16, FR-18 and NFR-05/08/10/12 as
`ops.schema_migrations/v1` (docs/contracts/ops-schema-migrations-v1.md). The
choices below are engineering decisions for this slice.

## No in-place migration at boot

APP01's store constructor migrates any older database it opens. Once a full
upgrade path exists that is an unauthorized mutation, so service entry points
open existing installations with `migrateExisting: false` and refuse to serve
an older schema. The migrating constructor still runs, but only on staged
copies (and OPS02 quarantine files) and on brand-new databases. Because the
service cannot run against an old schema, older installations are upgraded
offline (`bun src/main.ts upgrade`, owner password) through the same
`Application` commands as the Web.

## Control state in files beside the database

The journal, its accepted request receipts and the admission fence live in
atomically replaced files, not in tables of the database being swapped. A
journal row inside the image is necessarily stale after activation (it was
copied before migrate/validate wrote theirs) and cannot record intent for its
own replacement. Files survive the swap, restarts and old schemas that lack
the table. Receipts are mirrored into the database only when the attempt ends.

## Fence plus epoch digest

The fence file stops every known managed writer (application commands, job
admission and pumping, schedules, delivery) and survives restarts. Because a
fence can only cover writers that check it, activation is also bound to a
digest of all managed state taken at migrate. Any write between migrate and
the swap fails activation closed instead of being discarded. Hashing every row
is linear in installation size; validation is bounded per table and fails
closed beyond the bound rather than sampling.

## One recovery point through staged backup creation

Prepare reuses `stageManagedBackup` (the `backup.create` implementation), so
the native snapshot runs exactly once through Schway's asynchronous
`snapshotSessions` and the recovery point is an ordinary verified
`ops.backup_manifest/v1` backup. Preflight reads only declared engine metadata
(availability, snapshot contract, format version) and never snapshots.

## Atomic swap and identity-based recovery

`swapFrom` now assembles the full replacement image (installation-scoped rows
copied in, claims cleared) before replacing the file by rename, so a crash
leaves either database whole. An activation intent is resolved on reopen by
comparing the live digest with the validated staged digest and the
pre-activation digest; a match with neither stays blocked. When the schema does
not change, both digests are equal and either outcome is the validated state.

## Rollback only before activation

Before activation the live installation is untouched, so rollback discards the
staged copy and keeps live; it can never erase newer tombstones, settlements
or outbox results. After activation, returning to the prior version is a
restore of the recovery point, which must go through OPS02 quarantine and
current-ledger replay. Upgrade rollback therefore never swaps an image.

## Follow-ups

- OPS02 (#33) quarantine state still lives in `restore_quarantines` inside the
  swapped database and restore activation does not reconcile under service
  ownership; it can adopt this contract's file journal, fence and
  `ManagedService.resume`.
- OPS07 (#35) resolved: the package flow (`upgradePackage`, `service
  upgrade`) stops the unit and runs the new build's `upgrade` before switching
  the release and health-checking; see docs/contracts/ops-service-package-v1.md.
- Fixture historical schemas are the only evidence until a real release
  exists. Native session storage is never migrated; a future engine contract
  change needs a supported Schway migration API first.
