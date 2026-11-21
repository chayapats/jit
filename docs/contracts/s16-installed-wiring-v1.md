# s16-installed-wiring/v1

Status: implemented protected wiring protocol and installed dispatcher, with
disposable conformance. Aggregate selected lifecycle and real Linux enforcement
remain separate. See [ADR 0129](../adr/0129-s16-retained-installed-wiring.md).

This protocol removes/restores only the fixed root-owned S15 controller unit,
journald namespace and proxy socket unit. The protected credential-service unit
under its original user's home is retained unchanged, like accounts, linger,
credentials and disks. Root never unlinks or rewrites that service-owned path.
Fixed user-manager commands disable/restore its original activation separately.
No host path comes from a client, archive, model or ordinary export.

`openS16WiringMaintenance` returns before current resources open. Input binds an
original request, remove/restore direction, canonical protected configuration,
actual executing operator, fixed current package and both complete wiring-value
hashes. A wiring value includes bounded regular single-link unit bytes, owner,
group, mode and explicit absence. It is not application authority. Per-unit
bytes are at most 8 KiB and the canonical aggregate is at most 48 KiB.

Under genuine current installation/CHAT/controller exclusion, `prepare` captures
every selected/retained SQL logical image through actual writer reservations,
the complete native namespace and the credential-unit hash. Bind this cohort
into the original command before durable admission, so a killed preparation
cannot rebind later SQL activity. No protected payload/native byte is written;
deep native backup/working-disk capture is outside this narrow operation.

Removal admits an uninstall; restoration admits an upgrade of wiring for the
same selected executable. The immutable plan binds original input, operations/
owner/request identities, admission/time and current cohort. Current control
independently pins its hash. Root publishes those exact plan bytes before `arm`
confirms original plan custody, advances activation and journals physical intent.
`inspect` requires that actual intent; phase alone is insufficient. An already
armed partial operation resumes its original intent without allocating another.

Restoration additionally requires a completed original uninstall in the actual
current journal, with one independently confirmed wiring effect whose prior/
target/observed hashes exactly reverse the new command. Missing or mismatched
original facts refuse. Root snapshot metadata alone never grants restoration.

After fixed-path readback, `complete` requires original intent, current package,
the unchanged SQL/native/credential-unit cohort and exact target wiring. Original
SQL cuts close conclusively before completion; the helper process/context must
dispose before boot. Changed current data or wiring retains the original fence.
A terminal retry returns its historical receipt before old physical readback;
it cannot delete wiring restored by a later operation or rewind current data.

`openS16RootWiringJob` owns or genuinely borrows the separately excluded selector.
It privately retains original input, configuration/state/package/wiring snapshot,
plan and result. At most 256 jobs and 64 metadata objects per job are retained;
each canonical file is at most 64 KiB. Corrupt/missing original objects refuse.
Inactive crash temporaries are never adopted. Original job retries use original
plans and reconcile per-unit absence/exact-original values. Different occupied
units refuse. Only root writes fixed parents; publication/fsync/readback happens
under genuine installer exclusion. Staged crash temporaries are bounded to 16
per parent and never become restoration sources.

The supervisor must conclusively stop the controller and named working VMs,
disable original activation before removal, reload after physical wiring and
restore original activation before completion. It never reports a VM stop as
settlement/refund of unknown work/effects. Root job results certify historical
wiring only, separately from current service health.

`openS16InstalledWiring` adds a stable private root locator. Resume unfinished
original removal/restoration before admitting a new uninstall. Reinstall always
reconciles original removal, restores only its original receipted unit bytes and
enablement/keyring active state, then boots the current selected service after
operator disposal. A healthy rerun observes the same process without restart.
Later different source uses the separate guarded release protocol over fresh
current state; no legacy composition-manifest fallback is used.

Missing original units may bind only bounded original unit bytes under the
genuine live root selector for the exact prefix/UID. Structural substitutes,
different identity/config/state/Bun or changed present unit bytes refuse.
Normal upgrade retains its exact unit/inode check. Retained stop readback accepts
only loaded/not-found, inactive/failed, dead/failed, literal zero main/control
PIDs, no queued job/drop-ins, control-group/mixed kill mode and enabled final
SIGKILL; unknown or process-only manager policy is never presumed stopped.

The initial supported uninstall requires the selected artifact's actual wiring
helper and compatible pinned Bun. An earlier package must explicitly upgrade
first; uninstall does not silently change code. Preserve current root selector/
wiring metadata alongside the installation; historical points are not authority
to reconstruct it. Missing root/current authority requires separate diagnosis.

Conformance uses actual sealed helpers, owning current SQL/native namespace and
root filesystem/leases. Account, manager, VM-stop and HTTP ports are scripted
disposable fixtures, not real Linux/UID/VM/credential-service enforcement or
owning-client acceptance. No external account/device is used.
