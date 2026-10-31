# BOX14-01 Linux evidence — opt in only

Linux evidence is per architecture/build. The disk-pool follow-up uses a disposable arm64 Linux VM and the installed-service harness below; exact pass/fail results, build identities and raw evidence belong in the ignored `.local/s14-live-hosts.md` record, with a credential-free PR summary. An unprivileged LXC without loop devices cannot provision this pool. x64 VM, reboot, paid inference, website login and UI/device/accessibility acceptance remain separate gates. Fixtures/configured images do not prove Linux support. Requirements: FR-35/36/38/40; NFR-04/06/07/14.

`ops/box/s14-probe.ts` is credential-free. Default/`--diagnostics` probes readiness only. `--smoke` starts two specially named probe computers and writes synthetic markers in dedicated probe filesystems; it never opens application/native state or provider/website sessions. It leaves markers for inspection and removes probe containers in `finally`. Never point it at real Bot storage. It never pulls images or retries another backend.

## Host prerequisites and diagnostics

Use the application's non-root service identity and rootless Podman through its own verified local Unix socket (or an explicit local development client). Record exact Bun/Podman/image digests/kernel/architecture/checkout SHA in ignored `.local/s14-box14-smoke/`. Installation addresses and raw host outputs stay there, never in tracked files/ordinary exports.

| Reason | Operator investigation |
| --- | --- |
| `podman_missing` / `podman_probe_unavailable` | Check the selected local executable as the service identity. |
| `linux_required` / `rootless_required` | Require Linux/rootless Podman; no rootful or host-shell replacement. |
| `subuid_subgid_range_required` | Check >=65536 subordinate UID/GID ranges, `/etc/subuid`, `/etc/subgid`, `newuidmap/newgidmap` and outer LXC mappings. A one-ID map is insufficient. |
| `nested_user_namespace_unavailable` | Check unprivileged user namespaces and outer Proxmox/LXC nesting. Do not disable application hardening or run privileged. |
| `fuse_device_or_storage_driver_unavailable` | Check `/dev/fuse` visibility/permissions and rootless storage driver. Outer-host provisioning is explicit; a working alternative driver need not use FUSE. |
| `nested_network_device_unavailable` | Inspect `/dev/net/tun` and Podman helper needs. This backend uses `--network=none` and itself needs no TUN; internet egress is not a workaround. |
| `cgroup_delegation_required` / `computer_cgroup_limits_unenforced` | Require cgroup v2, CPU/memory/PID delegation and actual finite kernel values/zero swap. Check outer LXC and inner user-manager delegation. Accepted flags are insufficient. |
| `persistent_disk_mounts_required` / `dedicated_ext4_disk_boundary_required` | Re-run the root installer to provision/repair the dedicated pool. Shared filesystems, subdirectory binds, symlinks and directory-size watchers fail. |
| `persistent_disk_limit_unenforced` | Each component's total filesystem capacity must fit the finite disk ceiling, including on restart. Provision smaller dedicated storage; never omit the limit. |
| `computer_isolation_unverified` | Check mounts, namespaces, pinned images, tmpfs bounds, read-only root, capabilities and no-new-privileges. Ambiguous inspect formats remain unsupported. |
| `computer_local_podman_required` | Require the current service uid’s actual protected Unix API socket and matching daemon hostname/uid mapping. TCP/SSH, foreign, linked and missing sockets refuse; no automatic fallback. |

## Credential-free smoke

Provision an **isolated test pool**, distinct from the application computer root, through the same root `provisionS14Disks` installer API. It needs a protected manifest and eight finite pairs; do not use active Bot storage. The standalone probe uses only the first two slots and never reads application/native/provider state. The regular `install.sh --s14` provisions the application's pool automatically; its scoped lifecycle is tested separately.

Set non-secret `JIT_S14_SMOKE_ROOT`, actual digest-pinned `JIT_BOX_IMAGE_BASE`, `JIT_BOX_IMAGE_BROWSER` and the service's `JIT_PODMAN_MODE=remote` / `XDG_RUNTIME_DIR`. Run as its service identity. Record exact revisions and results in `.local/s14-live-hosts.md`; no addresses or raw output enter tracked files.

```sh
bun --no-env-file ops/box/s14-probe.ts --diagnostics
bun --no-env-file ops/box/s14-probe.ts --smoke
```

Pool/runtime failures are not permission to disable service hardening or use a host shell. `computer_disk_pool_full_rerun_installer_to_extend` requires `install.sh --s14 --computer-slots N`; overcommit requires more host space. Re-runs retain data and mount image identity. Initial committed capacity is 16 GiB plus the installer reserve; sparse allocation does not waive that requirement.

The installer and compatible-code `service upgrade` prepare the exact runtime user-namespace image mapping before activation, including reused images. This can take longer than computer startup on slow storage; the 30-second runtime ceiling stays unchanged. Preparation never starts an image or mounts Bot data. An upgrade with configured images refuses activation if mapping preparation or cleanup fails; inspect rootless storage/space and retry the upgrade. Do not manually bypass the phase or clear Podman's image/layer cache while the service runs. After an operator removes that cache or changes subordinate mappings, re-run install/upgrade before measuring cold computer startup. Measure independent bounded fsync/metadata latency as well as prepared cold/warm starts before attributing a timeout to disk or to a Podman major version.

The smoke checks container mounts/namespaces/hardening, kernel CPU/memory/PID/swap limits, bounded unique filesystems, cross-Bot marker/profile/socket denial, direct-network/raw-socket denial, owner-image capture and workspace/profile marker persistence across process recreation. The profile marker is synthetic and proves no real website login. Failure remains a blocker; finite limits may not be weakened.

## Additional acceptance evidence — all pending

- [ ] For each host record revision/images/kernel/Podman/Bun and smoke output. Inspect absence of state/native/credential/control-socket mounts and inherited environment; retain raw output locally.
- [ ] Fill only disposable probe storage beyond capacity with bounded writes; require ENOSPC, intact sibling/host state, then remove only probe-generated files.
- [ ] Exercise bounded memory/PID/CPU pressure; verify enforcement, host responsiveness, startup deadline and five-minute idle stop. No silent limit removal.
- [ ] In the opt-in service use typed `work.start` selecting a Bot with explicit `computer` capability. Verify lazy start, image, exact form takeover, late agent denial, named stop/reset/delete and retained other-Bot data. Ungranted Jit cannot access another computer.
- [ ] Restart service and reboot both hosts: require generation/lease fencing, retained data, no input/work/effect replay and explicit resumed authority. Pending reset/delete must not replay.
- [ ] Verify profile isolation with synthetic markers, runner/symlink/socket attempts. Real website login is unsupported here; do not add broad egress. Public navigation/private site adapters require separately reviewed brokers.
- [ ] Opus UI acceptance: no-script coordinate/text/key forms, lease/states/reasons, activity/unknown outcomes, mobile/keyboard/assistive evidence. No WebSocket/CSP exception.

Only label a host supported after applicable evidence passes. Link ignored evidence in the orchestrator's private record and include a credential-free PR summary; deterministic tests do not establish the Linux boundary.

CODE14 opt-in refinement (current schema 16): ordinary/model/Phase A and protected-browser components remain network-free. An explicit repository registry scope can run a separately bounded ephemeral check through the existing CONNECT allowlist proxy; it adds no website adapter or credential mount. `/run` tmpfs is now bounded at 128 MiB for bundle/runner scratch; `/tmp` stays 64 MiB. Registry access needs working rootless bridge networking as well as the existing disk/cgroup proof. Missing namespace/gateway/proxy enforcement refuses without a host/direct-network fallback. See the pending CODE14 live procedure in [execution-box.md](execution-box.md); it covers scope denial/revocation, routing/allowlist, script isolation and trusted private/public preload. None of that live evidence ran in this implementation.

## Installed service lifecycle evidence (no model)

`ops/box/s14-computer-evidence.ts` is an explicitly destructive **disposable-host-only** harness. It requires `JIT_S14_COMPUTER_EVIDENCE=1`, holds the installed runtime lock and refuses any computer/slot claim in the normal application database. Run it instead of `serve` in the installed hardened `jit-s14.service`, with the same identity, environment, mount namespace and all sandbox directives. Change only `ExecStart`, add the opt-in flag and set `Restart=no` through a temporary `/run/systemd/system/jit-s14.service.d/90-computer-evidence.conf`; restore the normal descriptor after the round. Do not run it beside a live service or on a pool containing actual Bot data.

It creates a separate synthetic S14 store beside the installed database, provisions a synthetic owner privately, uses typed setup/work/computer/takeover commands and actual `BotPodmanRuntime`. It never invokes a provider/native model. The first invocation proves runner/profile/socket/network denial, captures a real PNG, exercises owner input, waits five actual minutes, verifies idle stop and reopens the same computer. It emits `awaiting_unit_restart`, closes its store and exits. Start the same unit again to prove boot generation fencing, workspace/profile persistence and a second screenshot. It then resets both filesystems, verifies they are empty, deletes the claim and accepts a scripted proposal for Bot B. An orphan marker injected into the returned slot must be wiped before B starts; B is reset/deleted afterwards. Only safe pass/fail checks and screenshot size/hash are output. Its temporary owner password stays in a private mode-0600 file in the synthetic state tree and is removed after success. Failed rounds retain state for diagnosis; never erase real application state to retry them.

Capture the safe results, exact source/build digests and any failures in the ignored host record. Remove the temporary unit override, reload systemd and start the ordinary S14 service afterwards. This proves the installed kernel/runtime/lifecycle with a synthetic store and no model, not a research/provider/UI acceptance pass or reboot evidence.
