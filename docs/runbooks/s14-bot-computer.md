# BOX14-01 Linux evidence — opt in only

**Pending:** Ubuntu 24.04 x86_64 in an unprivileged Proxmox LXC, and arm64 Lima Linux VM. This implementation turn did not run Podman, paid inference, real website login or Linux smoke. Fixtures/configured images do not prove Linux support. UI/device/accessibility acceptance remains Opus work. Requirements: FR-35/36/38/40; NFR-04/06/07/14.

`ops/box/s14-probe.ts` is credential-free. Default/`--diagnostics` probes readiness only. `--smoke` starts two specially named probe computers and writes synthetic markers in dedicated probe filesystems; it never opens application/native state or provider/website sessions. It leaves markers for inspection and removes probe containers in `finally`. Never point it at real Bot storage. It never pulls images or retries another backend.

## Host prerequisites and diagnostics

Use the application's non-root service identity and rootless local Podman client. Record exact Bun/Podman/image digests/kernel/architecture/checkout SHA in ignored `.local/s14-box14-smoke/`. Installation addresses and raw host outputs stay there, never in tracked files/ordinary exports.

| Reason | Operator investigation |
| --- | --- |
| `podman_missing` / `podman_probe_unavailable` | Check the selected local executable as the service identity. |
| `linux_required` / `rootless_required` | Require Linux/rootless Podman; no rootful or host-shell replacement. |
| `subuid_subgid_range_required` | Check >=65536 subordinate UID/GID ranges, `/etc/subuid`, `/etc/subgid`, `newuidmap/newgidmap` and outer LXC mappings. A one-ID map is insufficient. |
| `nested_user_namespace_unavailable` | Check unprivileged user namespaces and outer Proxmox/LXC nesting. Do not disable application hardening or run privileged. |
| `fuse_device_or_storage_driver_unavailable` | Check `/dev/fuse` visibility/permissions and rootless storage driver. Outer-host provisioning is explicit; a working alternative driver need not use FUSE. |
| `nested_network_device_unavailable` | Inspect `/dev/net/tun` and Podman helper needs. This backend uses `--network=none` and itself needs no TUN; internet egress is not a workaround. |
| `cgroup_delegation_required` / `computer_cgroup_limits_unenforced` | Require cgroup v2, CPU/memory/PID delegation and actual finite kernel values/zero swap. Check outer LXC and inner user-manager delegation. Accepted flags are insufficient. |
| `persistent_disk_mounts_required` / `dedicated_ext4_disk_boundary_required` | Provide two separately mounted dedicated ext4 filesystem roots per Bot. Shared filesystems, subdirectory binds, symlinks and directory-size watchers fail. |
| `persistent_disk_limit_unenforced` | Each component's total filesystem capacity must fit the finite disk ceiling, including on restart. Provision smaller dedicated storage; never omit the limit. |
| `computer_isolation_unverified` | Check mounts, namespaces, pinned images, tmpfs bounds, read-only root, capabilities and no-new-privileges. Ambiguous inspect formats remain unsupported. |
| `computer_local_podman_required` | Remote Podman cannot prove local bind sources in this slice; no automatic fallback. |

## Credential-free smoke

Provision an isolated operator-owned root. `probe_a/workspace`, `probe_a/profile`, `probe_b/workspace`, `probe_b/profile` must each be the root of a **different dedicated ext4 filesystem**, capacity <=1 GiB. Formatting/mounting disposable storage is an operator action; the probe does neither. Give the rootless service identity ownership/private parent permissions. The image user maps through `keep-id`. No real session/application/credential/backup belongs there. For unprivileged LXC, the outer host may need to supply the exact filesystem roots; unsupported nested mounting remains unavailable.

Set non-secret `JIT_S14_SMOKE_ROOT`, digest-pinned `JIT_BOX_IMAGE_BASE`, `JIT_BOX_IMAGE_BROWSER`, explicit `JIT_PODMAN_MODE=local`. Use `ops/box/Containerfile` targets/runner/relay and record the actual build revision/digests. Then explicitly run on **each host**:

```sh
bun --no-env-file ops/box/s14-probe.ts --diagnostics
bun --no-env-file ops/box/s14-probe.ts --smoke
```

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
