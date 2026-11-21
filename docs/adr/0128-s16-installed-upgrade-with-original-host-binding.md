---
status: implemented installed upgrade adapter; aggregate lifecycle/host acceptance pending
date: 2026-11-21
scope: OPS16-01; S16-AC21; FR-04/15/18/23/35/38; NFR-02/04/05/08/09/12
---

# Route adopted S16 upgrades through the guarded root/service protocol

The legacy S15 installer refreshes host identities/configuration, renders units
and may restore an earlier composition manifest on failed startup. ADR 0122
prevents empty reconstruction, but that fallback still cannot preserve all
selected/retained S16 formats. ADR 0127 and the scoped owning lifecycle proof now
provide a current-state-preserving selection protocol.

Select an early adopted-S16 installer path before identity, credential, config,
unit or current-state changes. Require existing canonical service identity,
current state/composition, protected configuration and public service binding.
Preserve exact configuration/UIDs and existing unit bytes. Never refresh VMM
identity or manufacture an owner link during this upgrade. Fresh/default S15 and
explicit legacy paths retain their separate contracts. Selected existing S16
state without operations adoption must explicitly adopt before an upgrade; it
cannot silently enter the composition-manifest fallback.

Hold the genuine root selector capability through staging, original installer
locator and guarded release job. A borrowed capability must pass an actual
private-map/prefix/UID check; structural objects are not exclusion. Keep immutable
job inputs/plans separately from the small atomic root installer locator. A
rerun resumes an unfinished retained package/request first. Stable code identity
ignores only build identity/time for raw-source retry comparison; an explicitly
selected artifact retains its exact content pin. A completed failed trial is
reported as compatible fallback, never as successful installation of its target.
Another invocation may create a distinct attempt after that terminal outcome.

The systemd port uses fixed argv, proves controller stop from kernel-manager
state/MainPID/control/job readback, and checks the active process around bounded
loopback health. It does not stop working VMs during upgrade. The actual package
helper still owns all current SQL/native/external/owner proofs. Real systemd and
distinct-UID adoption remain #431; deterministic fixture ports are labelled.

New S15 artifacts declare Schway's actual supported public release contract,
instead of the obsolete bridge metadata label. This does not change the engine
or import another runtime. The initial compatible route keeps pinned Bun/engine/
dependencies/lock and refuses unsupported prior packages without rewinding data.

Uninstall/reinstall preservation remains an explicit integration obligation;
this decision does not authorize deleting state, credentials, disks or receipts.

The early route selects an existing operations directory (including a missing
ledger) or explicit file/file-memory/routine/voice configuration. Existing
default S15 and explicit legacy paths keep their documented baseline contracts.
The S15 dry-run simulator refuses this route before simulated identity/config
steps; its dummy release/marker objects cannot certify a guarded upgrade.

`openS16InstalledUpgrade` implements the borrowed selector and retained root
locator. `bindS16InstalledService` pins exact config/unit bytes and inodes, Bun
identity, state identity and original non-login account; local VMM account and
configured UID/path stay exact. It rejects manager drop-ins, stale unit cache,
unknown fields, queued jobs, control PIDs and nonzero stopped PIDs. Health has a
30-second total budget and requires the same active process around loopback
HTTP. A compatible fallback returns its explicit result; the installer reports
failure to install the target rather than a successful target installation.

Deterministic conformance uses actual old/current sealed helpers, public native
operations, root files/leases and package publication. Account/systemd/HTTP ports
are scripted, and the private path policy uses the fixture UID. The separate
[owning lifecycle proof](../evidence/s16-service-release-proof.md) covers real
service/client work. Neither proof establishes installed Linux enforcement,
uninstall/reinstall integration, physical devices/accounts or cutover.
