# s16-guarded-release-selection/v1

Status: protected protocol/root coordinator and installed upgrade adapter.
Uninstall/reinstall and actual Linux adoption remain separate conformance.
See [ADR 0127](../adr/0127-s16-guarded-release-selection-protocol.md).

The root installer owns immutable packages, units, private job metadata and the
`current` symlink. The existing service identity owns current protected state.
Root holds the separately excluded selector for the entire job, conclusively
stops the controller, and invokes a verified retained operator with fixed argv,
clean environment, bounded stdin/stdout and finite process-group timeout. No
installation, account, configuration, credential or working-VM change is granted
by this protocol. Production paths/identity come from the trusted installer;
alternate ownership, runner and supervisor ports are explicit fixtures only.

`openS16GuardedSelection` returns before current resources open. Its immutable
input binds original request, exact config hash/path, retained operator hash,
root prefix, both release paths and package hashes. Source/target are distinct
direct children of `releases` with independently verified root-owned trees and
runtime dependencies. The actual Bun version must match the selected artifacts.

`prepare` holds genuine installation/CHAT/source capabilities through a complete
protected backup and upgrade admission. It authenticates the original retained
point, compares its SQL image hashes, file/GitHub catalogs and helper/external
references to current owning state, and freshly deep-verifies original owned
native staging. An interrupted pre-admission backup cannot be rebound to later
activity. A stale backup refuses before upgrade admission; retain its point and
use a distinct operation after diagnosing current state.

The original plan binds input, independent operations ID, owner hash, original
operation/admission/time, backup receipt and complete current cohort hashes. Its
hash is a `capture_backend` intent. Root publishes these exact private bytes
atomically before confirming the plan. No archive supplies a host path or
historical authority. Missing/corrupt original plans refuse; only an unconfirmed
preparation under the original source path can reproduce its original plan.

Before `arm`, root runs both actual sealed packages' owning current readers and
actual completed-backup response commands under the original gate. SQL readership
alone is insufficient: require original terminal receipt identity across packages,
current control/config/owner/cohort hashes and compatible engine/dependency/lock
pins. Namespace metadata has its own bounded per-row encoder (20,000 rows per
array, 4 MiB), preserving prior small-set hashes without command-array limits.
This observation is not native deep verification or physical helper settlement.

The service operator rechecks complete current backup equivalence and native
bytes, confirms the original plan, advances original upgrade phases and records
`select_package` intent before root effect. Root's `inspect` readback must show
the actual selector intent; phase `activating` alone never permits selection.
Root then applies the original path-value operation (ADR 0125). An already selected
target is idempotent. Another path, package, config, cohort or original plan refuses.

`complete` requires original selector intent, exact desired root path/package,
current SQL/payload/helper/external/native equivalence and conclusive native/cut
disposal. It confirms original selection and completes the upgrade. Root starts
the service only after the helper conclusively releases its original context.
Unknown disposal retains original capabilities while alive and leaves the durable
admission gate in place. No original model/VM/effect is retried or settled here.

`openS16ReleaseJob` owns or genuinely borrows root exclusion, private original input/plans and historical
results. Fixed root jobs allow at most 256 retained jobs and 64 metadata objects
per job; individual records are at most 64 KiB. Atomic publication never replaces
an unexpected object; inert crash temporaries are not adopted. Terminal job retry
returns its original result without stopping a later service or changing state
or selector. It reports historical health, not a new liveness observation.
Only the original live selector capability for the exact prefix/root UID can be
borrowed. A structural clone, unacquired, closed or differently scoped object
refuses. The installer owns final disposal. A nonterminal stale job refuses an
unrelated current executable before stopping its service.

Failed/unknown trial start or health requires a conclusive stop and a **new reverse
selection** over a fresh complete current backup. Actual older readers and terminal
semantics must accept every current format and fact, including trial writes. No
old composition, SQL, authority, payload, native snapshot or working disk is restored.

An unsupported fallback may discard only its unarmed plan: independently recheck
the actual currently selected source readers/terminal response, current backup and
native state, original root source value and absence of **every** selector intent.
Confirm only original plan publication and discard the upgrade; preserve all data
and receipts. Record a private aborted fallback and require a distinct verified
forward operation. Any selector intent or uncertain physical selection refuses
this abort and retains the original gate. Unknown effects never become settled.

Conformance uses immutable earlier `23cfb85d` and current sealed packages, plus a
`4e2a80f8` reader that reads current SQL but fails terminal semantics. Actual marked
SIGKILL boundaries span controller preparation and root stop/plan/intent/effect/
completion/trial/result. Supervisor and UID transition remain labelled fixture
ports. These tests do not establish actual owning service dispatch, native UI,
live accounts, Linux isolation or owner-host cutover.

The separate [owning lifecycle proof](../evidence/s16-service-release-proof.md)
uses actual earlier/current service processes and a sealed shared client with
persistent scripted external ports. It covers current trial policy/withdrawal/
private/unknown state and fresh work after compatible fallback. Rendered clients
and real-host/device acceptance remain separate.

## Installed upgrade adapter

[ADR 0128](../adr/0128-s16-installed-upgrade-with-original-host-binding.md)
routes existing operations or explicit file/file-memory/routine/voice state
before legacy installer identity/configuration/credential/unit changes. Missing
adoption refuses; no legacy manifest fallback is attempted. Default S15 and
explicit legacy contracts remain separate. The dry-run S15 simulator refuses
this path rather than manufacturing evidence from dummy packages.

`openS16InstalledUpgrade` returns before opening root resources. Its original
capability owns selector exclusion through trusted staging, locked dependency
installation, freezing into new root inodes, package publication and the release
job. Protected config/unit/Bun/state/identity guards surround supervisor effects.
No account creation, UID refresh, owner-link preparation, VM start/stop or current
composition rewrite occurs. New artifacts declare the actual public Schway
release contract. The initial compatible route requires the same pinned Bun,
engine, dependency seal and lock; unsupported earlier packages refuse.

A bounded private atomic `installer.json` locator retains original job inputs
separately from immutable per-job plans. Resume that job before processing a new
source. An interrupted failed trial reports its original compatible fallback
first. Another invocation may create a distinct attempt. Corrupt/missing original
job evidence is never reconstructed. Exact artifact requests retain their full
content pin; raw-source no-op comparison ignores only build ID/time, never files,
metadata, modes, runtime or lock. A no-op creates no operation/health receipt.

The manager port uses fixed absolute getent/systemctl argv and clean environment.
Require the original non-login user/home/UID/GID and local VMM account; retain
config/unit bytes and inodes, Bun metadata and state directory identity. Manager
readback requires the original fragment, no drop-ins or pending daemon reload,
exact user/group and all explicit state/PID/job fields. Unknown/queued/running
control state refuses. Stop requires inactive/failed, dead/failed substate and
literal zero main/control PIDs. Start requires active/running with a real PID.
Bounded loopback login readiness preserves the configured Host and verifies the
same active PID before and after HTTP; a response alone is insufficient.

Tests use scripted account/manager/HTTP ports with actual sealed old/current
helper processes and root filesystem exclusion/publication. This proves adapter
composition, original locator resume and compatible fallback, not real systemd,
distinct Linux identities, uninstall/reinstall or physical settlement.
