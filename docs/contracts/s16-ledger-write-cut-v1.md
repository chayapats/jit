# s16-ledger-write-cut/v1

Status: protected internal source-cut component of OPS16-01 under
[ADR 0117](../adr/0117-s16-forward-payload-recovery-with-current-control.md).
It is not a full cohort, durable receipt, repair plan or activation permission.

`S16ControlMaintenance.currentLedgerCut()` reserves the actual complete current
SQL set: outer owner/lifecycle/recipient/site, selected/retained runtime sources
and current auxiliary controller journals. The parent retains the cut before
the first reservation, including an opener whose disposal fails. Retirement
refuses an unreleased cut; final parent close disposes original reservations
before closing any owning source or releasing process exclusion.

The shared `openS16LedgerWriteCut` primitive accepts trusted owning handles,
reviewed readers and a synchronous current guard. It sorts unique source names,
refuses duplicate handles, existing transactions, foreign persisted attachments,
read-only/query-only handles, unsupported readers and busy writers. For each
source it acquires `BEGIN IMMEDIATE` and proves the actual main writer with
zero-row DML. The probe changes no row, fires no row trigger and dirties no page.
All reservations precede integrity and bounded current image reads. Limits are
256 sources, 1 GiB per logical database and 2 GiB total (or a smaller explicit
ceiling), checked before serialized image allocation.

The live cut supplies bounded `serialize(name)`, `assertCurrent()` and original
`close()`, with `released` readback. Serialization applies only the existing
documented SQLite conversion of journal-mode bytes 18/19 to rollback mode; every
other source byte and format remains unchanged. The source is not opened,
created, checkpointed, migrated or closed by this primitive. Complete
`captureS16LedgerSet` now shares these actual reservations and serialization,
retaining its original durable image/manifest protocol and format.

The guard and original transactions must remain current. Changed own-connection
row counts, schema cookie or application/format stamp invalidate a cut, as does
a lost reservation. Guards must not mutate sources or retain asynchronous work.
Disposal rolls back only this cut's acquired transactions; a pre-existing
transaction that made opening fail remains untouched. Unknown rollback keeps
the same disposal capability unreleased for retry, retaining parent process
exclusion. A released cut cannot read or certify current state.

`currentPayloadReferences(cut)` is the only exception to the reference reader's
generic busy-transaction refusal. The parent checks the original live capability
against **every exact current source handle**. A private registry authenticates
the actual cut; caller-created objects, copied methods, partial cuts, old
transactions and released cuts cannot supply it. Nested FILE/GitHub/DATA15
metadata reads remain scoped to that cut and their observations expire when it
releases. No caller-supplied callback declares a transaction fresh.

Actual CLI-initialized fixture evidence verifies independent process writers
before/during/after the complete cut, unchanged source images, row/schema/format
mutation refusal, unknown rollback and original parent disposal retry, partial
opening with a pre-existing transaction, forged/partial/released capability
refusal and actual current GitHub pins. A real WAL write followed by source
close/checkpoint/reopen preserves the same serialized current image; a later
current row write changes it. No extra SQLite header normalization or semantic
row merge is introduced. This component does not activate bytes, reconstruct
lost current authority or complete forward restore/lifecycle acceptance.
