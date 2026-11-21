---
status: selected recovery contract; writer-cut seam implemented; activation and aggregate acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Recover immutable payloads while preserving current control in place

[ADR 0104](0104-s16-forward-recovery-and-retained-admission.md) requires forward
recovery without restoring historical authority. Required missing/corrupt current
SQL refuses; the candidate cannot reconstruct newer withdrawals, private scope,
charges or unknown effects that only existed after its capture.

Select an initial forward recovery operation that keeps every current control
ledger, native root, helper journal, credential, client binding and working disk
in place. An independently receipted historical point supplies only immutable
payload bytes named by exact current metadata. Capturing a complete independent
current cut remains necessary, but replacing readable current SQL with its own
copy would add crash and lock-transfer boundaries without repairing the missing
payload. Replacing it with historical SQL would violate the authority baseline.
The source-retirement seam in ADR 0115 remains available for a separately proved
current-cohort activation; this operation does not claim that capability.

Current SQL remains readable and under genuine installation/CHAT/controller
exclusion throughout. A shared owning writer-cut primitive acquires actual
SQLite writer reservations over every selected/retained current source, verifies
the actual reader/integrity/finite logical size and retains those reservations
during synchronous payload activation. Read-only/query-only connections, existing
transactions, foreign attachments and busy writers refuse. Rollback failure
retains the original cut/disposal capability and process exclusion for retry.
The [shared writer-cut contract](../contracts/s16-ledger-write-cut-v1.md) is
implemented. Complete SQL capture uses this same reservation implementation,
not a second weaker approximation. No source row, header or schema is written.

Preparation must bind the complete current SQL images, current FILE/GitHub pins,
native lifecycle/custody, helper/external facts and actual compatible package.
Operations revision alone is insufficient. Authenticate the entire candidate
against current retained-point and completed-backup receipts before decoding
its bounded catalogs, verify actual SQL integrity/readers and public native
ancestry in private quarantine, and recheck current custody after asynchronous
work. Archive paths never choose live or scratch destinations. Unsupported or
missing required current/native continuity refuses; an old native session is
never restored into live custody.

Only fixed FILE logical names and GitHub bundle identities can select candidate
payloads. Exact current pins supply hashes and FILE lengths; an authenticated
candidate supplies a bounded GitHub length. Intact newer current files need not
exist in the older point and stay unchanged. A missing current immutable member
without an exact candidate refuses the complete operation. Unreferenced,
withdrawn, pending and parser leftovers stay quarantined. Stored artifact pins
remain inert: current ancestry, expiry, publication, recipient and private-scope
checks still decide release; copying bytes never changes those owning facts.

Before activation, persist the original operation/fence, independent current
cohort receipt and immutable repair plan. Bind exact prior/target bytes and
identities, independently owned staging and per-member progress outside targets.
Use only enumerated atomic file replacement and parent fsync; do not replace
directories with locks, overwrite changed/unowned targets, guess deletion from
a suffix or copy archive SQL. Retry recognizes only the original plan and
prior/target identities. New current facts invalidate preparation and retain the
gate. A journal's finite action count must not silently truncate a larger repair
set: bounded per-member progress belongs to the original aggregate action.

After conclusively releasing SQL reservations, revalidate the complete current
SQL/native/helper/external/package facts before completing the receipt and
clearing admission. Unknown provider/VM effects retain their original identities
and remain blocked/deduplicated; no refund, action, speech or notification replay
follows from the older point. Restored bytes must work through the actual owning
service/client, with newer withdrawal/private retirement/usage/unknown facts
asserted before and after, plus real SIGKILL at every durable boundary.

This choice does not provide bare recovery from lost current authority, working
disk rollback or historical native resurrection. Required current corruption
refuses without empty reconstruction. Compatible service/client lifecycle and
the complete selected-stack acceptance remain required by #429; physical host,
account and cutover evidence remain #431/#432.
