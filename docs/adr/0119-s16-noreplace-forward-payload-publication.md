---
status: implemented protected payload repair; aggregate operations acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Publish missing current payloads without replacing existing names

[ADR 0117](0117-s16-forward-payload-recovery-with-current-control.md) keeps every
current authority ledger/native/helper/disk in place. The independently retained
[current cohort](../contracts/s16-forward-current-cohort-v1.md) supplies current
pins and physical custody; a separately verified retained point supplies only
exact missing immutable bytes. Present corrupt bytes refuse; unrelated historical
or withdrawn bytes never become targets.

Select same-parent private empty temps, independently pinned by an immutable
original repair plan before the first byte write. Current SQL chooses only fixed
FILE logical names and GitHub bundle IDs. Current FILE pins supply size/hash;
verified candidate inventory supplies a bounded GitHub size matching its current
digest. One missing pin without exact candidate bytes refuses the whole operation.
A missing byte parent can be created only from current continuity and separately
journalled empty inode ownership; missing SQL/parser/native state is never created.

A check-then-rename can replace an unexpected target created between the check and
rename. Select atomic **no-replace hard-link publication** for these absent targets
instead. Each original temp has one link before publication. Linking it to the
fixed absent target is atomic and refuses an occupied name. Parent fsync precedes
removing the original temp name, then another parent fsync and independent readback
confirm the target. Both names may temporarily exist with exactly two links to
the same independently planned inode. Retry recognizes only temp-only, both-names
or target-only states with original inode/private attributes and complete expected
hash. Unknown extra links, changed bytes/inodes or occupied targets refuse; no
existing target is overwritten or deleted. Unsupported filesystems refuse rather
than falling back to replacement. Temp and target share a parent/filesystem.

The immutable per-member plan and these actual owned names/inodes/link counts/
hashes are durable per-member progress. A mutable progress file is unnecessary
and cannot authorize skipping work. One original aggregate capture/replace action
avoids the operations journal's 256-action limit for up to 20,000 byte members.
Every member's allowed transitions and prior absence are bound before writes;
parent fsync/readback makes each transition durable. Partial owned temp writes may
resume only after their entire existing prefix matches the authenticated source.
There is no truncation, overwrite, filename-based ownership or history-derived
current authority.

Strict current byte collectors intentionally reject repair temps and invalidate
an original missing-byte observation after repair. The coordinator instead checks
an explicit independently receipted original plan: all original present files/
directories/absences and exact namespace membership must remain, except its exact
owned parent/temp/target transitions. Complete current SQL images/source identities
and public-native/helper/external/package facts revalidate before preparation and
completion. Actual writer reservations protect synchronous final publication;
release conclusively before asynchronous final verification. Complete owning byte
collectors then verify precisely original plus repaired current pins, no temps,
no other new members and no changed pending/parser/withdrawn custody.

Only conclusive original disposal, complete independent readback and unchanged
current authority allow observing the original publication and clearing admission.
Original unknown provider/VM actions remain blocked/deduplicated; copying a byte
never refunds usage, revives a private computer, publishes an artifact or replays
work/speech/notifications. Actual owning service/client and compatible release
lifecycle acceptance remain required. Physical/account/device/cutover evidence is
separate. Finite combined staging plus same-parent-temp quotas refuse without
truncation, automatic eviction or cleanup of unknown files.
