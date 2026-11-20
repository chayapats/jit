---
status: selected source contract; aggregate lifecycle acceptance incomplete
date: 2026-11-20
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Bind point files and interrupted removal to independent current receipts

The component capturers do not publish an aggregate point. Select one fixed
point layout with ledger/payload indices and current-reference/capture metadata.
The complete file inventory follows authenticated component indices, not a
recursive guess at which files belong to a point. SQL/native semantic validation
and current authority remain separate owning gates; a file inventory is not
permission to restore or execute historical state.

Select explicit protected-operator removal of one retained point, never an
automatic age/count eviction. The ten-point ceiling refuses another backup until
an appropriate point is explicitly removed. Current continuity, unfinished
operations and their receipts are outside historical deletion targets.

Before unlinking, authenticate the point against the existing current journal,
verify its exact bounded files and persist a private removal plan outside the
point. Bind that plan's hash in the original remove action ID. The plan retains
the exact file hashes/identities and directory identities. Retries can recognize
already absent files while refusing substituted, extra or changed files; no
archive chooses a destination or a new removal operation.

Deleting a directory recursively after checking only its manifest could remove
new or unowned content. Requiring the entire original point on every retry would
make a successful partial unlink unrecoverable. A bounded original plan plus
per-file readback permits interrupted removal without reconstructing or guessing
ownership. Uncertainty keeps the original fence and removing state until the
same plan proves the point absent and its original action is confirmed.

This implements file custody and retention, not aggregate capture, native
ancestry validation, forward activation or complete #429 acceptance. Tests use
disposable point-format fixtures; no installed backup, account or real VM is
removed. Complete producer and lifecycle acceptance remain required.
