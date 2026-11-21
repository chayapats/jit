---
status: implemented protected extension; aggregate operations acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Retire only independently owned completed recovery staging

[ADR 0119](0119-s16-noreplace-forward-payload-publication.md) retains private
candidate/current SQL/native copies after completing forward payload repair.
They consume the finite combined recovery quota and need explicit retirement.
Deleting a guessed operation directory or allowing generic recursive cleanup
would discard independent ownership and interrupted-removal evidence.

Extend the protected `retire-staging` operator to select a **complete** restore.
Keep the existing backup retirement contract/plan bytes unchanged. Recovery
retirement uses a separately versioned v2 command/plan over one fixed original
`operations/forward-recovery/<sourceOperationId>` root, never canonical repaired
bytes or caller-supplied paths. Recompute its scope from current operations,
owner/configuration and original request/point/admission/time. Its independently
confirmed original `recovery_own_<scope>` action must bind the original root and
three role directory inodes before a removal plan can be prepared.

Reuse the existing explicit file-hash/inode/directory inventory, independent
immutable plan outside deletion, original removal intent/readback, bounded
unlink/rmdir plus parent fsync, partial progress and reappearance refusal. Permit
only the implemented candidate/current/repair metadata, current SQL, native
envelopes and original fixed quarantine/scratch roles. Opaque native descendants
remain inert private copies. New or changed members after preparation, links,
special nodes, missing ownership and substituted roots refuse untouched.

Current exclusion and conclusive release of original resources remain required.
Nonterminal/discarded restores and unknown original disposal cannot be retired.
This action never abandons, settles or retries recovery/effects; backup abort
remains backup-only. Completed restore retry must still return the original
receipt after staging removal and must not resurrect later withdrawals. Current
SQL/native/credentials/disks/client sessions, canonical payloads, retained points
and all original operation/removal receipts survive. No automatic eviction or
compatible release lifecycle acceptance follows from this extension.
