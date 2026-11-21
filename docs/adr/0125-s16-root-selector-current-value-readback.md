---
status: implemented root filesystem primitive; coordinator and lifecycle conformance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Select an immutable release through a separately excluded root filesystem role

[ADR 0124](0124-s16-sealed-package-current-reader-probe.md) proves actual target
reader observations, not executable selection. The controller identity owns
current authority and maintenance leases; root owns immutable releases, units
and the `current` symlink. Passing a structural maintenance capability across
those identities would neither preserve its process lease nor grant root access.

Select a small trusted root filesystem primitive over a fixed installation
prefix under [s16-root-selector-value/v1](../contracts/s16-root-selector-value-v1.md).
It acquires a genuine exclusive process lease in a separate private root
coordination directory, reusing the existing inode-bound SQLite lease rather
than adding another authority journal. This role contains coordination metadata
only, never controller state, policy, credentials or historical authority. Missing
or corrupt retained lease evidence refuses; it is never reset during a release
selection. A bootstrap failure precedes controller changes.

Observe the current symlink's canonical target under the fixed `releases`
directory. Its digest describes the **currently selected path**, independently
of whether that path's package is healthy. That distinction permits replacing a
corrupt selected executable with a separately verified compatible release. The
controller's original plan must independently bind the actual package hash and
current cohort. Root path-value readback alone is not compatibility or admission
authority, nor evidence of historical execution/attempt counts.

Before physical selection, require the original expected current path-value
digest and independently expected target package content hash. Verify the full
root-owned immutable target tree/dependencies and exact release identity. An
already selected desired path is idempotent; stale or unexpected values refuse.
Create a first symlink with exclusive creation. Replace an existing symlink by
staging a private random root-owned symlink, rechecking the original value and
atomically renaming it, then fsync the parent and read back the exact target.
Never replace an unexpected regular file, follow a linked parent or delete an
unknown temporary object. A live attempt may remove only its own unchanged
staged inode. A hard-killed attempt may leave an inert root temporary symlink;
readback/retry never needs to adopt or execute it.

Unknown physical completion retains the original controller operation fence.
The root primitive does not start a service, edit its configuration, touch current
SQL/native/disks, clear a gate, grant an application action or automatically roll
back. Its trusted coordinator must first stop the controller, durably receipt
the exact command/cohort/selector intent under current owner exclusion, use the
actual target-reader probe, and accept current path readback only under that
original intent. Release/fallback requires complete current facts and conclusive
original resource disposal. Health failure after trial service writes requires
a fresh current cohort and actual old-reader proof, never old-data restoration.

The alternative of making service state root-owned would collapse the existing
identity boundary. Guessing source compatibility from a symlink or a historical
composition file would miss adopted formats and current trial-service facts.
Keep root path selection and controller authority distinct, bound by a reviewed
coordinator. This primitive has no ordinary client/actor route or standalone
selection CLI. Actual root/supervisor integration and owning client lifecycle
remain required; fake-root filesystem conformance does not certify Linux adoption.
