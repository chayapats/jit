---
status: implemented retained-wiring protocol/dispatcher; aggregate lifecycle/host acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Preserve original installed wiring across uninstall and reinstall

ADR 0128 protects adopted upgrades, but the legacy uninstall path has no shared
root exclusion or durable selected-service admission fence. A retained-state
reinstall must not run identity/config refresh, owner-link preparation or the
legacy composition fallback after unit removal.

Select a narrow root-wiring protocol, separate from package/data selection.
Keep the genuine root selector through uninstall/reinstall. Stop the existing
controller conclusively and use the actual retained sealed operator as its
original identity. Validate current owning stores, owner/configuration, fixed
package selection and current SQL/native namespace; retain original admission
and physical wiring intent before removing or restoring fixed unit paths.
Current control admits an uninstall operation for removal and an upgrade
operation for restoration of the same selected executable's wiring. Both carry
an explicit versioned wiring command and target value, never data activation.

Root privately retains bounded original wiring bytes and independent config,
identity/package/state pins before removal. Only the original root-owned
controller unit, journald and proxy socket are eligible. The credential service's
unit remains unchanged under its original user-owned home: root never traverses
service-writable directories to unlink/replace it. Stop/restore its user-manager
process separately through the fixed original identity, preserving local and
global enablement. This narrower choice
preserves credential scaffolding like accounts and linger, avoiding temporary
ownership changes to the protected home. Its exact wiring hash remains in the
current continuity proof. No archive or caller can
choose another host target. Original intent/plan hashes are confirmed in current
control; root readback of the whole fixed present/absent value precedes terminal
clearance. Unknown intent retains the fence and original job for reconciliation.
Terminal retries are historical receipts, not permission to remove later wiring.

Uninstall proves the working VMs stopped through the existing manager/kernel
port before removing any wiring. It preserves accounts, config, current stores,
native state, credentials/keyring, packages, receipts, disks and snapshots. It
never treats a VM stop as settlement/refund of unknown effects. No protected
payload or native snapshot is replaced, so this narrow operation does not need
to duplicate a complete backup; current owning SQL/namespace continuity remains
independently checked. Protected backups remain separately available.

Reinstall first reconciles any original unfinished removal. It restores only
original receipted wiring over verified absence or exact original bytes, reloads
the manager, completes its original fence and starts the same executable only
after current proof and conclusive operator disposal. Then a requested different
source uses ADR 0128's guarded upgrade. Missing config/current state, package,
identity or original wiring custody refuses without empty reconstruction or
credential/account changes. Real Linux/physical settlement remains #431.

The initial supported uninstall requires the selected immutable package to
contain this wiring helper. An earlier package refuses before a root locator or
controller stop; first use ADR 0128's compatible upgrade. Uninstall never silently
upgrades code merely to obtain its operator. The source/package is independently
qualified again before every helper invocation.

Restoration must additionally name the independently completed original
uninstall in current control, whose confirmed physical action binds both old
present and absent wiring hashes. Root snapshot bytes alone cannot authorize a
new restoration. The protected credential unit's hash stays in the current
cohort throughout; root never deletes or replaces it.

`openS16InstalledWiring` holds genuine root exclusion through the stable locator,
original root jobs, activation receipts and post-restoration boot. It preserves
original controller/keyring enablement and keyring active state. The existing
VM stop port now refuses unknown manager state even when no QEMU process was
observed. Missing units can bind only original unit bytes under the original
live root selector capability; normal upgrade still requires exact present
unit/inode binding. Stop recovery requires explicit zero main/control PIDs and
no manager job, including a conclusively absent unit. A healthy rerun observes
the original running process without restarting it.

Deterministic tests use actual sealed helpers/current SQL/native namespace,
fixed filesystem publication and process exclusion. Manager/account/VM/HTTP
ports are explicit fixtures. Partial removal/restoration resumes original plans;
changed current SQL, missing independent original uninstall, unperformed intent
and occupied different unit custody refuse. The separate
[owning lifecycle proof](../evidence/s16-service-release-proof.md) now couples
this dispatcher to actual sealed owning service/client processes with current
withdrawal/private/policy/unknown-effect facts and fresh work after reinstall.
Account/systemd/VM/readiness ports remain explicit fixtures. Fresh-selected
installation, final aggregate matrix and real-host enforcement remain separate
acceptance work.
