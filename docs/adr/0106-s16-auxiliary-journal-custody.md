---
status: selected source contract; aggregate acceptance incomplete
date: 2026-11-20
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Retain auxiliary controller custody without application recovery

ADR 0104 keeps current helper/physical ownership independent of historical
archives. The Firecracker controller retains original commands in separate
`runtime/vm-firecracker/<managerId>.sqlite` journals. They are absent from the
composition manifest; omitting them loses original unknown-effect dedupe.
Constructing their ordinary adapter also converts accepted/dispatched states
and may later reconcile host effects. Maintenance must not use that constructor.

Select raw existing-journal inspection under the same retained process lease
as the owning adapter, behind installation and CHAT exclusion. Bind each journal
to its exact current VM manager/installation/reader and validate original
commands/receipts without dispatch, credential access or root-helper RPC. Copy
it as a separate selected SQL source; historical bytes remain inert. Root-helper
physical settlement still requires its own authenticated current protocol.

Reusing the adapter constructor would mutate custody during observation.
Recursive directory copying would include process locks or omit owning identity.
A second shadow runtime would duplicate authority. Raw owning-format inspection
plus the existing lease is simpler and leaves original intent states unchanged.

Before any header or lock descriptor opens, reserve the canonical journal path
inside the process. This complements existing SQLite process locks: on POSIX,
closing a failed second opener's descriptor can release the original process's
record locks. Both ordinary DurableJournal and maintenance participate. Retain
that reservation after unknown disposal; only conclusive data/lease close may
release it. No lock inode is replaced or deleted, and process death remains the
cross-process release boundary.

This supplies current controller continuity, not helper-disk capture, native
host acceptance or complete aggregate backup/recovery. Parser/backend/device
custody and aggregate publication/retention still require their owning paths.
