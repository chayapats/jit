---
status: implemented guarded protocol and scoped owning lifecycle; installer/host acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Bind root executable selection to the current controller cohort

Retain the root/controller identity split from ADR 0125. Root excludes other
qualified installers, conclusively stops the service, and invokes a separately
verified retained operator as the existing service identity. The operator owns
genuine current-state capabilities; no serialized object substitutes for them.

Select `s16-guarded-release-selection/v1` over a composition-file rollback. The
operator completes a protected current backup, admits one original upgrade,
and records the hash of an immutable plan before executable selection. Root
stores those exact private plan bytes outside controller state. The plan binds
owner/configuration/operator, original backup, both root selector values and
package hashes, original operation/admission and current SQL/payload/external/
helper/native namespace hashes. Rechecking native bytes uses ADR 0126's original
owned backup staging. No historical authority or working disk is restored.

Before arming selection, independently run both actual sealed packages' current
readers and completed-backup response path under the original durable gate.
Require exact current cohort and compatible pinned engine/dependencies/lock.
The older package must retain completed responses across repackaging, as in ADR
0123; SQL readership alone does not establish that semantic compatibility.
Record `select_package` intent before root changes `current`. Completion
requires original current cohort, current native deep verification, exact root
path/package readback and conclusive resource disposal before service restart.

An interrupted intent retries the original path-value operation; another path,
command, package, missing original plan or changed cohort refuses. A completed
operation returns its original receipt without modifying a later selection.
After trial service writes, fallback is a new reverse selection with a fresh
current backup and actual older-reader proof. Never replace current policy,
withdrawal, charge, unknown-effect receipt or native state with the first backup.
Unsupported current formats retain their gate and require a verified forward
operator; a legacy composition manifest is not a fallback authority.

The protected protocol and disposable root/service composition are implemented.
Installer routing and uninstall preservation remain required aggregate outcomes.
Real Linux identity enforcement and host adoption remain separate acceptance.

The [scoped owning lifecycle proof](../evidence/s16-service-release-proof.md) now
uses actual earlier/current service processes and one sealed shared client, with
persistent scripted external ports. It preserves current trial policy fencing,
withdrawal, private retirement, owner-stopped VM and unknown-effect charges across
fallback, then executes fresh work under the current policy. Installer/systemd
routing, uninstall and real-host acceptance remain separate.
